import { Prisma, type PluginInstall, type PluginOverride } from '@prisma/client'
import prisma from '@/lib/prisma'
import { isValidVersion, satisfies } from '@/lib/semver'
import { auditPlugin } from './audit'
import { CatalogError, findCatalogPlugin, isRevoked, loadCatalog, type LoadedCatalog } from './catalog'
import { now } from './clock'
import { likePrefix } from './dataStore'
import { lastExportAt } from './exportData'
import { FetchRemoteError, fetchRemote } from './fetchRemote'
import { isValidPluginId } from './ids'
import { checkAndStage } from './installChecks'
import {
  EXPORT_FRESH_MS,
  INSTALLED_STATUSES,
  LifecycleError,
  exportMarkerKey,
  installView,
  type InstallView,
} from './lifecycleCommon'
import { markStale, type StaleReason } from './overrides'
import { isPluginPermission } from './permissions'
import { PLUGIN_PLATFORM_VERSION } from './platformVersion'
import {
  PluginConflictError,
  beginOperation,
  createForInstall,
  endOperation,
  findInstall,
  heartbeat,
  transition,
  type Operation,
  type PluginStatus,
} from './registry'
import { RunnerError, RunnerUnavailableError, runnerHealth, runnerReload } from './runnerClient'
import { registrySkill, type RegistrySkill } from './skillPartsRegistry'
import { commitVersion, discardStaging, removePluginFolder, removeVersion, versionExists } from './staging'

export { EXPORT_FRESH_MS, LifecycleError, installView, type InstallView } from './lifecycleCommon'

/**
 * The plugin lifecycle (README.PLUGINS.md §9): install, enable, disable, uninstall. Each
 * runs inside the admin's request (TD-21) and is audited with before and after.
 *
 * - Install, update and uninstall hold an operation lease (registry.ts), so two admins,
 *   two webapp copies or reconciliation never work on one plugin at once, and a crashed
 *   operation is found by its expired lease (§9.7).
 * - Enable and disable are one compare-and-set on `enabled`, refused while an operation
 *   holds a live lease.
 * - The database write is the commit: until it lands the runner, the UI and the agent
 *   ignore the folder; reconciliation removes a folder no row references.
 * - The runner is told after every change. The runner runs only `ready` rows, so an
 *   install commits `ready`, then reads the worker's state and moves to `failed` with the
 *   reason when it did not start (`runner_unavailable` when the runner cannot be reached;
 *   reconciliation retries).
 */
export interface LifecycleDeps {
  loadCatalog?: () => Promise<LoadedCatalog>
  fetchArchive?: (url: string) => Promise<Buffer>
  registrySkill?: (skillId: string) => Promise<RegistrySkill | null>
  platformVersion?: string
}

const defaults: Required<LifecycleDeps> = {
  loadCatalog: () => loadCatalog({ source: 'official' }),
  fetchArchive: async (url) => (await fetchRemote(url, { kind: 'archive' })).bytes,
  registrySkill,
  platformVersion: PLUGIN_PLATFORM_VERSION,
}

const withDefaults = (deps: LifecycleDeps = {}): Required<LifecycleDeps> => ({ ...defaults, ...deps })

const leaseFree = (): Prisma.PluginInstallWhereInput[] => [{ operationId: null }, { leaseExpiresAt: { lt: now() } }]
const isInstalled = (s: string) => (INSTALLED_STATUSES as readonly string[]).includes(s)
const liveLease = (r: PluginInstall) => !!r.operationId && !!r.leaseExpiresAt && r.leaseExpiresAt > now()

function checkPluginId(pluginId: string) {
  if (!isValidPluginId(pluginId)) throw new LifecycleError(400, 'invalid_plugin_id', 'Invalid plugin id.')
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))

const snapshot = (r: PluginInstall | null) =>
  r
    ? {
        status: r.status,
        enabled: r.enabled,
        activeVersion: r.activeVersion,
        previousVersion: r.previousVersion,
        dataVersion: r.dataVersion,
        grantedPermissions: r.grantedPermissions,
        lastError: r.lastError,
      }
    : null

function busyOrNotInstalled(row: PluginInstall | null, pluginId: string): LifecycleError {
  if (row && !isInstalled(row.status) && row.status !== 'available' && liveLease(row)) {
    return new LifecycleError(409, 'plugin_busy', `Plugin ${pluginId}: another operation is in progress.`)
  }
  if (!row || !isInstalled(row.status)) {
    return new LifecycleError(409, 'not_installed', `Plugin ${pluginId} is not installed.`)
  }
  return new LifecycleError(409, 'plugin_busy', `Plugin ${pluginId}: another operation is in progress.`)
}

/** The plugin's own data rows (not the platform's `__` rows) that a reinstall would find. */
async function hasKeptData(pluginId: string): Promise<boolean> {
  const row = await prisma.pluginData.findFirst({
    where: { pluginId, namespace: 'live', NOT: { collection: { startsWith: likePrefix('__') } } },
    select: { id: true },
  })
  return !!row
}

async function activeSetsOf(pluginId: string): Promise<Map<string, PluginOverride[]>> {
  const rows = await prisma.pluginOverride.findMany({ where: { pluginId, status: 'active' } })
  const sets = new Map<string, PluginOverride[]>()
  for (const r of rows) sets.set(r.changeSetId, [...(sets.get(r.changeSetId) ?? []), r])
  return sets
}

type WorkerOutcome = { ok: true } | { ok: false; lastError: string }

/** Asks the runner to converge on the run list, then whether this version's worker is up. */
export async function startWorker(pluginId: string, version: string): Promise<WorkerOutcome> {
  try {
    await runnerReload()
    const health = await runnerHealth()
    if (health.state === 'out_of_date') return { ok: false, lastError: 'runner_out_of_date' }
    const w = health.workers.find((x) => x.id === pluginId && x.version === version)
    if (!w) return { ok: false, lastError: 'worker_failed: the runner did not start a worker for this version' }
    if (w.state && w.state !== 'ready') return { ok: false, lastError: `worker_failed: the worker is ${w.state}` }
    return { ok: true }
  } catch (e) {
    if (e instanceof RunnerUnavailableError) return { ok: false, lastError: 'runner_unavailable' }
    if (e instanceof RunnerError) return { ok: false, lastError: `runner_error: ${e.code}` }
    throw e
  }
}

/** Reloads the runner when only stopping workers: a runner that is down converges at its next sync. */
async function tellRunner(pluginId: string, what: string) {
  try {
    await runnerReload()
  } catch (e) {
    const why = e instanceof RunnerUnavailableError ? e.reason : e instanceof RunnerError ? e.code : String(e)
    console.warn(`[plugins] ${what} ${pluginId}: the runner was not told (${why}); it converges at its next run-list sync`)
  }
}

/** After a commit as `ready`: the worker's state decides `ready` or `failed`. */
async function settleWorker(pluginId: string, version: string): Promise<PluginInstall> {
  const outcome = await startWorker(pluginId, version)
  const row = (await findInstall(pluginId))!
  try {
    if (outcome.ok) {
      if (row.status === 'failed') await transition(pluginId, { from: ['failed'], to: 'ready', patch: { lastError: null } })
      else if (row.lastError) await prisma.pluginInstall.updateMany({ where: { pluginId, OR: leaseFree() }, data: { lastError: null } })
    } else if (row.status === 'ready') {
      await transition(pluginId, { from: ['ready'], to: 'failed', patch: { lastError: outcome.lastError } })
    } else {
      await prisma.pluginInstall.updateMany({ where: { pluginId, OR: leaseFree() }, data: { lastError: outcome.lastError } })
    }
  } catch (e) {
    // Another operation took the plugin meanwhile; its outcome wins.
    if (!(e instanceof PluginConflictError)) throw e
  }
  if (!outcome.ok) console.warn(`[plugins] ${pluginId} ${version}: ${outcome.lastError}`)
  return (await findInstall(pluginId))!
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface InstallInput {
  version: string
  acceptedPermissions: string[]
  restoreOverrides?: boolean
}

function checkInstallInput(input: InstallInput) {
  if (!input || typeof input !== 'object') throw new LifecycleError(400, 'invalid_request', 'A JSON object is required.')
  if (typeof input.version !== 'string' || !isValidVersion(input.version)) {
    throw new LifecycleError(400, 'invalid_request', 'version must be a version x.y.z.')
  }
  if (!Array.isArray(input.acceptedPermissions) || !input.acceptedPermissions.every((p) => typeof p === 'string')) {
    throw new LifecycleError(400, 'invalid_request', 'acceptedPermissions must be a list of permission names.')
  }
  if (input.restoreOverrides !== undefined && typeof input.restoreOverrides !== 'boolean') {
    throw new LifecycleError(400, 'invalid_request', 'restoreOverrides must be true or false.')
  }
}

async function catalogOrFail(d: Required<LifecycleDeps>): Promise<LoadedCatalog> {
  try {
    return await d.loadCatalog()
  } catch (e) {
    if (e instanceof CatalogError) {
      throw new LifecycleError(503, 'catalog_unavailable', `The plugin catalog cannot be used: ${e.message}`, [e.code])
    }
    throw e
  }
}

/** Restores (or not) the active versions a kept plugin left behind; before the commit, so none applies early. */
async function settleOverrides(
  pluginId: string,
  restore: boolean | undefined,
  actorId: string,
  d: Required<LifecycleDeps>,
): Promise<{ restored: number; stale: number; cleared: number }> {
  const sets = await activeSetsOf(pluginId)
  const out = { restored: 0, stale: 0, cleared: 0 }
  if (!sets.size) return out
  if (restore === false) {
    for (const [changeSetId, rows] of sets) {
      const { count } = await prisma.pluginOverride.updateMany({
        where: { changeSetId, status: 'active' },
        data: { status: 'cleared', decidedBy: actorId, decidedAt: now() },
      })
      if (!count) continue
      out.cleared++
      await auditPlugin('plugin.override.reset', {
        actorId,
        pluginId,
        targetType: 'plugin_change_set',
        targetId: changeSetId,
        before: { status: 'active', revision: rows[0].revision },
        after: { status: 'cleared', reason: 'not restored at reinstall' },
        source: 'admin',
      })
    }
    return out
  }
  for (const [changeSetId, rows] of sets) {
    let reason: StaleReason | null = null
    try {
      for (const r of rows) {
        const skill = await d.registrySkill(r.targetGroup)
        const partId = r.targetKey.slice(r.targetKey.indexOf('/') + 1)
        const part = skill?.parts.find((p) => p.partId === partId)
        if (!part) {
          reason = 'part_removed'
          break
        }
        if (part.sha256 !== r.baseSha256) reason = 'factory_changed'
      }
    } catch (e) {
      console.warn(`[plugins] reinstall ${pluginId}: the agent's skill registry could not be read (${(e as Error).message}); ` +
        'restored versions are checked at the next reconciliation')
      out.restored = sets.size
      return out
    }
    if (!reason) {
      out.restored++
      continue
    }
    if ((await markStale(changeSetId, reason)).length) {
      out.stale++
      await auditPlugin('plugin.override.stale', {
        actorId,
        pluginId,
        targetType: 'plugin_change_set',
        targetId: changeSetId,
        before: { status: 'active' },
        after: { status: 'stale', staleReason: reason },
        source: 'admin',
      })
    }
  }
  return out
}

export async function install(
  pluginId: string,
  input: InstallInput,
  actorId: string,
  deps?: LifecycleDeps,
): Promise<{ plugin: InstallView }> {
  const d = withDefaults(deps)
  checkPluginId(pluginId)
  checkInstallInput(input)

  const loaded = await catalogOrFail(d)
  const entry = findCatalogPlugin(loaded.catalog, pluginId)
  if (!entry) throw new LifecycleError(404, 'not_in_catalog', `The catalog lists no plugin ${pluginId}.`)
  const release = entry.releases.find((r) => r.version === input.version)
  if (!release) throw new LifecycleError(404, 'release_not_found', `The catalog lists no release ${input.version} of ${pluginId}.`)
  const revoked = isRevoked(loaded.catalog, pluginId, release.version)
  if (revoked !== null) throw new LifecycleError(409, 'release_revoked', `Release ${release.version} was revoked: ${revoked}`)
  if (!release.permissions.every(isPluginPermission)) {
    throw new LifecycleError(409, 'unknown_contribution', `Release ${release.version} asks for a permission this RedAmon does not know.`)
  }
  if (!satisfies(d.platformVersion, release.platform)) {
    throw new LifecycleError(
      409,
      'platform_incompatible',
      `Release ${release.version} needs platform ${release.platform}; this RedAmon runs ${d.platformVersion}.`,
    )
  }
  if (!sameSet(input.acceptedPermissions, release.permissions)) {
    throw new LifecycleError(400, 'permissions_mismatch', 'The accepted permissions must be exactly the ones this release asks for.')
  }

  const existing = await findInstall(pluginId)
  let activeSets = 0
  if (existing) {
    if (existing.status !== 'available') {
      if (liveLease(existing)) throw new LifecycleError(409, 'plugin_busy', `Plugin ${pluginId}: another operation is in progress.`)
      throw new LifecycleError(409, 'already_installed', `Plugin ${pluginId} is already installed; update or uninstall it.`)
    }
    if (await hasKeptData(pluginId)) {
      if (existing.dataVersion > release.dataVersion) {
        throw new LifecycleError(
          409,
          'data_newer_than_release',
          `The data kept from an earlier install is at data version ${existing.dataVersion}, newer than this ` +
            `release's ${release.dataVersion}. Old code never runs on newer data: install a newer release, or export and purge the data.`,
        )
      }
      if (existing.dataVersion < release.dataVersion) {
        throw new LifecycleError(409, 'migration_required', `The kept data needs a migration to data version ${release.dataVersion}.`)
      }
    }
    activeSets = (await activeSetsOf(pluginId)).size
    if (activeSets && input.restoreOverrides === undefined) {
      throw new LifecycleError(
        400,
        'restore_choice_required',
        `This plugin left ${activeSets} approved skill version(s): say whether to restore them.`,
        [String(activeSets)],
      )
    }
  }

  const args = { version: release.version, restoreOverrides: input.restoreOverrides ?? null, by: actorId }
  let op: Operation
  try {
    op = existing
      ? await beginOperation(pluginId, ['available'], 'installing', 'install', args)
      : await createForInstall(pluginId, args)
  } catch (e) {
    if (e instanceof PluginConflictError) {
      throw new LifecycleError(409, 'plugin_busy', `Plugin ${pluginId}: another operation is in progress.`)
    }
    throw e
  }

  const refuse = async (code: string, message: string, status: number, details?: string[]) => {
    await discardStaging(op.operationId).catch(() => {})
    await endOperation(op, 'available', { lastError: `${code}: ${message}`.slice(0, 2000) }).catch(() => {})
    await auditPlugin('plugin.install_failed', {
      actorId,
      pluginId,
      before: snapshot(existing),
      after: { version: release.version, code, message },
      source: 'admin',
    })
    console.warn(`[plugins] install ${pluginId} ${release.version} refused: ${code}`)
    return new LifecycleError(status, code, message, details)
  }

  let bytes: Buffer
  try {
    bytes = await d.fetchArchive(release.url)
  } catch (e) {
    const why = e instanceof FetchRemoteError ? `${e.code}: ${e.message}` : (e as Error).message
    throw await refuse('download_failed', `The archive could not be downloaded (${why}).`, 502)
  }
  const checked = await checkAndStage(op.operationId, {
    pluginId,
    archiveBytes: bytes,
    release,
    platformVersion: d.platformVersion,
  })
  if (!checked.ok) throw await refuse(checked.code, checked.message, 422, checked.details)

  try {
    await heartbeat(op)
    // A folder of this version no row references (an earlier crash) gives way to this one.
    if (await versionExists(pluginId, release.version)) await removeVersion(pluginId, release.version)
    await commitVersion(op.operationId, pluginId, release.version)
    const overrides = await settleOverrides(pluginId, input.restoreOverrides, actorId, d)
    await endOperation(op, 'ready', {
      enabled: true,
      activeVersion: release.version,
      previousVersion: null,
      pendingVersion: null,
      dataVersion: release.dataVersion,
      previousDataVersion: null,
      grantedPermissions: release.permissions,
      manifest: checked.manifest as unknown as Prisma.InputJsonValue,
      catalogEntry: {
        version: release.version,
        url: release.url,
        sha256: release.sha256,
        platform: release.platform,
        dataVersion: release.dataVersion,
        permissions: release.permissions,
      },
      installedBy: actorId,
      installedAt: now(),
      lastError: null,
      revokedReason: null,
    })
    await auditPlugin('plugin.permissions_granted', {
      actorId,
      pluginId,
      after: { version: release.version, permissions: release.permissions },
      source: 'admin',
    })
    const row = await settleWorker(pluginId, release.version)
    await auditPlugin('plugin.install', {
      actorId,
      pluginId,
      before: snapshot(existing),
      after: { ...snapshot(row), overrides },
      source: 'admin',
    })
    return { plugin: installView(row) }
  } catch (e) {
    await discardStaging(op.operationId).catch(() => {})
    if (e instanceof PluginConflictError) {
      throw new LifecycleError(409, 'plugin_busy', `Plugin ${pluginId}: the install lost its lease to another operation.`)
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Enable, disable
// ---------------------------------------------------------------------------

async function setEnabled(pluginId: string, enabled: boolean): Promise<void> {
  const { count } = await prisma.pluginInstall.updateMany({
    where: { pluginId, status: { in: [...INSTALLED_STATUSES] }, OR: leaseFree() },
    data: { enabled },
  })
  if (count !== 1) throw busyOrNotInstalled(await findInstall(pluginId), pluginId)
}

export async function enable(pluginId: string, actorId: string, deps?: LifecycleDeps): Promise<{ plugin: InstallView }> {
  const d = withDefaults(deps)
  checkPluginId(pluginId)
  const before = await findInstall(pluginId)
  if (!before || !isInstalled(before.status) || liveLease(before)) throw busyOrNotInstalled(before, pluginId)
  if (before.revokedReason != null) {
    throw new LifecycleError(409, 'plugin_revoked', `This version was revoked by the catalog: ${before.revokedReason}`)
  }
  const range = (before.manifest as { platform?: unknown } | null)?.platform
  if (typeof range !== 'string' || !satisfies(d.platformVersion, range)) {
    if (before.status !== 'incompatible') {
      await transition(pluginId, { from: [before.status as PluginStatus], to: 'incompatible' }).catch(() => {})
    }
    throw new LifecycleError(
      409,
      'platform_incompatible',
      `This version needs platform ${String(range)}; this RedAmon runs ${d.platformVersion}. Update the plugin.`,
    )
  }
  await setEnabled(pluginId, true)
  // The runner runs only `ready` rows, so a failed plugin (Retry) is made `ready` first and
  // goes back to `failed` if its worker still does not start.
  if (before.status !== 'ready') {
    await transition(pluginId, { from: [before.status as PluginStatus], to: 'ready' })
  }
  const row = await settleWorker(pluginId, before.activeVersion as string)
  await auditPlugin('plugin.enable', { actorId, pluginId, before: snapshot(before), after: snapshot(row), source: 'admin' })
  return { plugin: installView(row) }
}

export async function disable(pluginId: string, actorId: string): Promise<{ plugin: InstallView }> {
  checkPluginId(pluginId)
  const before = await findInstall(pluginId)
  if (!before || !isInstalled(before.status) || liveLease(before)) throw busyOrNotInstalled(before, pluginId)
  await setEnabled(pluginId, false)
  await tellRunner(pluginId, 'disable')
  const row = (await findInstall(pluginId))!
  await auditPlugin('plugin.disable', { actorId, pluginId, before: snapshot(before), after: snapshot(row), source: 'admin' })
  return { plugin: installView(row) }
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export interface UninstallInput {
  mode: 'keep' | 'purge'
  confirm: string
}

/**
 * Removes `plugin:<id>` from every user's Models by feature (TD-10): one statement, not the
 * PUT route, which refuses internal callers. Returns the number of users changed.
 */
export async function stripFeatureModelKey(db: Pick<Prisma.TransactionClient, '$executeRaw'>, pluginId: string): Promise<number> {
  if (!isValidPluginId(pluginId)) throw new Error(`Invalid plugin id ${JSON.stringify(pluginId)}`)
  const key = `plugin:${pluginId}`
  return db.$executeRaw`UPDATE "user_settings" SET "feature_models" = "feature_models" - ${key} WHERE jsonb_exists("feature_models", ${key})`
}

async function purgeRows(tx: Prisma.TransactionClient, op: Operation) {
  const pluginId = op.pluginId
  const data = await tx.pluginData.deleteMany({ where: { pluginId } })
  const overrides = await tx.pluginOverride.deleteMany({ where: { pluginId } })
  await stripFeatureModelKey(tx, pluginId)
  await tx.pluginPlatformState.deleteMany({ where: { key: exportMarkerKey(pluginId) } })
  const { count } = await tx.pluginInstall.deleteMany({
    where: { pluginId, status: 'uninstalling', operationId: op.operationId },
  })
  if (count !== 1) throw new PluginConflictError(pluginId, 'the uninstall lost its lease')
  return { dataRows: data.count, overrideRows: overrides.count }
}

export async function uninstall(
  pluginId: string,
  input: UninstallInput,
  actorId: string,
): Promise<{ plugin: InstallView | null }> {
  checkPluginId(pluginId)
  if (!input || (input.mode !== 'keep' && input.mode !== 'purge')) {
    throw new LifecycleError(400, 'invalid_request', 'mode must be "keep" or "purge".')
  }
  if (input.confirm !== pluginId) {
    throw new LifecycleError(400, 'confirm_mismatch', `Type the plugin id (${pluginId}) to confirm.`)
  }
  const before = await findInstall(pluginId)
  if (!before || !isInstalled(before.status) || liveLease(before)) throw busyOrNotInstalled(before, pluginId)
  if (input.mode === 'purge') {
    const at = await lastExportAt(pluginId)
    if (!at || now().getTime() - at.getTime() > EXPORT_FRESH_MS) {
      throw new LifecycleError(409, 'export_required', 'Download the export of this plugin\'s data first (within the last hour).')
    }
  }

  let op: Operation
  try {
    op = await beginOperation(pluginId, [...INSTALLED_STATUSES], 'uninstalling', 'uninstall', { mode: input.mode, by: actorId })
  } catch (e) {
    if (e instanceof PluginConflictError) throw busyOrNotInstalled(await findInstall(pluginId), pluginId)
    throw e
  }
  try {
    // The run list no longer lists an uninstalling plugin: its worker stops before its code goes.
    await tellRunner(pluginId, 'uninstall')
    await removePluginFolder(pluginId)
    if (input.mode === 'keep') {
      await endOperation(op, 'available', {
        enabled: false,
        activeVersion: null,
        previousVersion: null,
        pendingVersion: null,
        previousDataVersion: null,
        lastError: null,
      })
      const row = (await findInstall(pluginId))!
      await auditPlugin('plugin.uninstall', {
        actorId,
        pluginId,
        before: snapshot(before),
        after: { ...snapshot(row), mode: 'keep' },
        source: 'admin',
      })
      return { plugin: installView(row) }
    }
    const counts = await prisma.$transaction((tx) => purgeRows(tx, op), { maxWait: 10_000, timeout: 120_000 })
    await auditPlugin('plugin.purge', {
      actorId,
      pluginId,
      before: snapshot(before),
      after: { mode: 'purge', ...counts },
      source: 'admin',
    })
    return { plugin: null }
  } catch (e) {
    if (e instanceof PluginConflictError) {
      throw new LifecycleError(409, 'plugin_busy', `Plugin ${pluginId}: the uninstall lost its lease to another operation.`)
    }
    throw e
  }
}
