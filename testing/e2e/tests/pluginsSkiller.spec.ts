import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { mintToken, signIn } from './auth'

/**
 * The review and versions flow end to end (README.PLUGINS.md §7.5-7.6), using the `echo` test
 * fixture as the proposing plugin (Skiller itself is phase 07). A proposal is created through
 * echo's propose_override action, then a person opens it from a project's Agent Skills
 * settings, reviews the before/after, approves it, sees the version active, and resets to
 * factory. Driven from project settings so no agent run is needed.
 *
 * Needs a stack trusting the throwaway fixtures key (see pluginsPage.spec.ts).
 */
const FIXTURES = join(__dirname, '..', '.plugin-fixtures')
const SEED_USER = process.env.REDAMON_USER || 'cmrzlj3xk0000ob3vo67o3igg'
const SKILL = 'path_traversal'
const SKILL_LABEL = 'Path Traversal / LFI / RFI'
let admin = process.env.REDAMON_ADMIN_USER || ''
let api: APIRequestContext
let projectId = ''

test.beforeAll(async ({ playwright, baseURL }) => {
  execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'make-plugin-fixtures.mjs'), FIXTURES], { stdio: 'ignore' })
  const seed = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `redamon-auth=${mintToken(SEED_USER)}` } })
  if (!admin) {
    // Prefer the seed user when it is an admin: it owns projects, so there is a project whose
    // Agent Skills settings can be opened (another admin, e.g. "test", may own none).
    const users = (await (await seed.get('/api/users')).json()) as { id: string; role: string }[]
    const admins = users.filter((u) => u.role === 'admin')
    admin = (admins.find((u) => u.id === SEED_USER) ?? admins[0])?.id ?? ''
  }
  await seed.dispose()
  api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `redamon-auth=${mintToken(admin)}` } })
})

test.afterAll(async () => {
  await api?.dispose()
})

async function ensureEcho(page: Page) {
  const list = await (await api.get('/api/plugins')).json()
  const echo = (list.plugins as { id: string; state: string }[]).find((p) => p.id === 'echo')
  if (echo && echo.state !== 'not_installed') return
  await page.goto('/plugins')
  await page.getByRole('button', { name: /install from file/i }).click()
  const dialog = page.getByRole('dialog')
  const inputs = dialog.locator('input[type="file"]')
  await inputs.nth(0).setInputFiles(join(FIXTURES, 'echo-1.0.0.tar.gz'))
  await inputs.nth(1).setInputFiles(join(FIXTURES, 'catalog.json'))
  await inputs.nth(2).setInputFiles(join(FIXTURES, 'catalog.json.sig'))
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: /^Install Echo 1\.0\.0/ }).click()
  await expect(dialog).toBeHidden({ timeout: 90_000 })
  await expect(page.getByTestId('plugin-card-echo').getByTestId('plugin-state')).toHaveText('Ready', { timeout: 60_000 })
}

/**
 * Clears the skill for the admin's user scope so the run starts on factory text: reset the
 * active version, then delete every remaining version (pending proposals and old versions left
 * by an earlier run).
 */
async function clearSkill(skill = SKILL) {
  await api.post('/api/plugins/overrides/reset', {
    data: { point: 'skill.text', group: skill, scopeType: 'user', scopeOwnerId: admin },
    headers: { 'Content-Type': 'application/json' },
  })
  const res = await api.get(`/api/plugins/overrides/versions?point=skill.text&group=${skill}`)
  if (!res.ok()) return
  const model = (await res.json()) as { scopes: { versions: { changeSetId: string; status: string }[] }[] }
  for (const scope of model.scopes) {
    for (const v of scope.versions) {
      if (v.status !== 'active') await api.delete(`/api/plugins/overrides/change-sets/${v.changeSetId}`)
    }
  }
}

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(!admin, 'No admin user in this database.')
  await signIn(context, admin, baseURL!)
  await context.addInitScript(() => {
    localStorage.setItem('redamon-v2-onboarding', JSON.stringify({ version: '2026-03-28-v2', acceptedAt: new Date().toISOString() }))
    localStorage.setItem('redamon-github-star-dismissed', '1')
  })
})

test('review a proposed skill version from project settings, approve it, then reset to factory', async ({ page }) => {
  test.setTimeout(240_000)
  await ensureEcho(page)
  await clearSkill()

  const projects = (await (await api.get('/api/projects')).json()) as { id: string }[]
  projectId = projects[0]?.id ?? ''
  test.skip(!projectId, 'No project to open settings for.')

  // echo proposes the factory text plus one marker line for the chosen skill (user scope).
  const proposed = await api.post('/api/plugins/echo/actions/propose_override', {
    data: { context: { projectId }, params: { skill: SKILL, part: 'payload_reference', scope: 'user' } },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(proposed.ok(), await proposed.text()).toBeTruthy()

  // Agent Skills is a tab of the project form (the plugin controls live under it); deep-link to it.
  await page.goto(`/projects/${projectId}/settings?tab=attack`)
  const skillRow = page.getByTestId(`plugin-skill-row-${SKILL}`)
  await expect(skillRow).toBeVisible({ timeout: 30_000 })

  // One pending proposal → open the versions modal, then the review.
  await skillRow.getByRole('button', { name: /pending/i }).click()
  await expect(page.getByText(/Versions ·/)).toBeVisible()
  await page.getByRole('button', { name: /open review/i }).click()
  await expect(page.getByTestId('review-header')).toBeVisible()
  await expect(page.getByRole('heading', { name: new RegExp(`Skill: ${SKILL_LABEL}`, 'i') })).toBeVisible()
  await expect(page.getByTestId('textdiff-row').first()).toBeVisible()

  // Approve, confirm.
  await page.getByRole('button', { name: /^Approve v/ }).click()
  await page.getByText(/from the next message or resume/i).waitFor()
  await page.getByRole('button', { name: /^Approve$/ }).click()

  // The chip now shows the applied version. The number is not fixed: the counter is never
  // reused (TD-19), so an earlier run leaves it higher than 2.
  await expect(skillRow.getByTestId('plugin-skill-chip')).toContainText(/changed by Echo · v\d+/i, { timeout: 30_000 })

  // Reset to factory; the version chip and the Versions/Reset controls go. The row itself
  // stays because echo also contributes a project.skills.row action for every skill.
  await skillRow.getByRole('button', { name: /reset to factory/i }).click()
  await page.getByRole('button', { name: /^Reset$/ }).click()
  await expect(skillRow.getByTestId('plugin-skill-chip')).toHaveCount(0, { timeout: 30_000 })
  await expect(skillRow.getByRole('button', { name: /reset to factory/i })).toHaveCount(0)

  await clearSkill()
})

/**
 * Skiller, the real plugin, end to end (phase 07): install it from files, analyse a seeded
 * session from the chat's gear menu, review and approve, twice; then the versions window
 * (delete, reset to factory) and a third run whose number is never a reused one (TD-19); the
 * model gate; uninstall keeping the data, reinstall restoring it, uninstall deleting everything.
 * Since Skiller 1.1.0 (platform 1.1.0) every run goes through RedAmon's skill picker, and one test
 * improves one of the person's own skills: saved as a NEW skill (`<name> v2`), switched on in the
 * project in place of its source, then a run on that one suggesting `v3`.
 *
 * Needs:
 * - Skiller packed and signed into SKILLER_DIST (default ../../redamon-plugins/dist):
 *   skiller-<SKILLER_VERSION>.tar.gz, catalog.json and catalog.json.sig (redamon-plugins README.md,
 *   "Developing a plugin against a local RedAmon"), with the signing key's public half in
 *   PLUGINS_EXTRA_TRUSTED_KEYS;
 * - the stub model of scripts/stub-llm-server.mjs, which this spec starts on the address the
 *   agent container reaches as host.docker.internal (STUB_LLM_HOST, or asked from the agent
 *   container), and registers for the admin as an OpenAI-compatible provider, removed at the end.
 * Skipped when the files are missing. SKILLER_EVIDENCE_DIR, when set, receives screenshots.
 *
 * SKILLER_FROM_CATALOG=1 installs Skiller from its card in the official catalog instead (no
 * files, no extra trusted key): the catalog must be the signed, official one and list Skiller
 * at SKILLER_VERSION (1.0.0 by default in that mode, which has no picker and no user skills).
 */
const FROM_CATALOG = process.env.SKILLER_FROM_CATALOG === '1'
const SKILLER_VERSION = process.env.SKILLER_VERSION || (FROM_CATALOG ? '1.0.0' : '1.1.0')
const WITH_PICKER = SKILLER_VERSION !== '1.0.0'
const VERSION_RE = SKILLER_VERSION.replace(/\./g, '\\.')
const SKILLER_DIST = process.env.SKILLER_DIST || join(__dirname, '..', '..', '..', 'redamon-plugins', 'dist')
const SKILLER_FILES = [`skiller-${SKILLER_VERSION}.tar.gz`, 'catalog.json', 'catalog.json.sig']
const USER_SESSION = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'skiller-user-session.json'), 'utf8')) as {
  skillName: string
  skillDescription: string
  skillContent: string
  events: { type: string; data: unknown }[]
}
/** The agent's record of a user skill's text: the first 16 hex of its SHA-256 (agentic skill_part_seam.py). */
const sha16 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
const SESSION = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'skiller-session.json'), 'utf8')) as {
  skillId: string
  events: { type: string; data: unknown }[]
}
const SQLI = 'sql_injection'
const SQLI_LABEL = 'SQL Injection'
const EVIDENCE = process.env.SKILLER_EVIDENCE_DIR || ''

function envValue(name: string): string {
  const env = readFileSync(join(__dirname, '..', '..', '..', '.env'), 'utf8')
  const line = env.split('\n').find((l) => l.startsWith(`${name}=`))
  const value = line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '') : ''
  if (!value || value === 'changeme') throw new Error(`${name} is not set in .env`)
  return value
}

/** Where the agent container reaches the host: the stub must listen there. */
function agentHost(): string {
  if (process.env.STUB_LLM_HOST) return process.env.STUB_LLM_HOST
  const out = execFileSync('docker', ['exec', 'redamon-agent', 'getent', 'hosts', 'host.docker.internal'], { encoding: 'utf8' })
  return out.trim().split(/\s+/)[0]
}

async function shot(page: Page, name: string) {
  if (!EVIDENCE) return
  mkdirSync(EVIDENCE, { recursive: true })
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`) })
}

test.describe.serial('Skiller', () => {
  let stub: ChildProcess | null = null
  let providerId = ''
  let ready = false
  let sessionId = ''
  let firstLabel = 0
  // The user-skill test's own rows, removed in afterAll: skills created or saved, sessions
  // seeded, and the project's toggles as they were.
  const ownSkills: string[] = []
  const ownSessions: string[] = []
  let savedToggles: unknown = undefined

  const versions = async () => {
    const res = await api.get(`/api/plugins/overrides/versions?point=skill.text&group=${SQLI}`)
    const model = (await res.json()) as { scopes: { scopeType: string; versions: { changeSetId: string; status: string; revision: number | null }[] }[] }
    return model.scopes.find((s) => s.scopeType === 'user')?.versions ?? []
  }

  const setModel = async (model: string) => {
    const res = await api.put(`/api/users/${admin}/settings`, {
      data: { featureModels: { 'plugin:skiller': model } },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
  }

  async function openInstallDialog(page: Page) {
    await page.goto('/plugins')
    const dialog = page.getByRole('dialog')
    if (FROM_CATALOG) {
      await expect(page.getByTestId('catalog-status')).toContainText('Official catalog')
      const card = page.getByTestId('plugin-card-skiller')
      await expect(card.getByTestId('plugin-state')).toHaveText('Not installed')
      await expect(card).toContainText(`${SKILLER_VERSION} available`)
      for (const title of ['Read chat sessions', 'Use a language model', 'Propose agent instructions',
        ...(WITH_PICKER ? ['Propose versions of your own skills'] : [])]) {
        await expect(card.getByText(title, { exact: true })).toBeVisible()
      }
      await shot(page, 'catalog_card')
      await card.getByRole('button', { name: 'Install', exact: true }).click()
      return { dialog, install: dialog.getByRole('button', { name: new RegExp(`^Install ${VERSION_RE}`) }) }
    }
    await page.getByRole('button', { name: /install from file/i }).click()
    const inputs = dialog.locator('input[type="file"]')
    await inputs.nth(0).setInputFiles(join(SKILLER_DIST, `skiller-${SKILLER_VERSION}.tar.gz`))
    await inputs.nth(1).setInputFiles(join(SKILLER_DIST, 'catalog.json'))
    await inputs.nth(2).setInputFiles(join(SKILLER_DIST, 'catalog.json.sig'))
    return { dialog, install: dialog.getByRole('button', { name: new RegExp(`^Install Skiller ${VERSION_RE}`) }) }
  }

  async function installSkiller(page: Page) {
    const { dialog, install } = await openInstallDialog(page)
    await expect(dialog.getByText(/sees this data while it works/)).toBeVisible()
    await dialog.getByRole('checkbox').check()
    await shot(page, 'install_consent')
    await install.click()
    // A reinstall over kept data asks, after the first click, whether to restore the approved
    // versions Skiller left; answer "restore" and install again.
    const restore = dialog.getByRole('radiogroup', { name: 'Approved skill versions' })
    let answered = false
    await expect(async () => {
      if (!answered && (await restore.isVisible())) {
        await restore.getByRole('radio', { name: /restore them/i }).check()
        await shot(page, 'reinstall_restore')
        await install.click()
        answered = true
      }
      await expect(dialog).toBeHidden({ timeout: 5_000 })
    }).toPass({ timeout: 90_000 })
    await expect(page.getByTestId('plugin-card-skiller').getByTestId('plugin-state')).toHaveText('Ready', { timeout: 60_000 })
  }

  async function openSession(page: Page, id = sessionId) {
    await page.goto(`/graph?project=${projectId}`)
    // /graph closes every drawer when its project changes, and the ?project= one is applied
    // after the first render: wait for the graph, then open the chat until it stays open.
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--drawer-bottom') !== '')
    const history = page.getByRole('button', { name: 'Session history' })
    await expect(async () => {
      if (!(await history.isVisible())) await page.getByRole('button', { name: 'Toggle AI Agent' }).click()
      await expect(history).toBeVisible({ timeout: 3_000 })
      await page.waitForTimeout(500)
      await expect(history).toBeVisible()
    }).toPass({ timeout: 60_000 })
    await history.click()
    await page.locator(`[title="${id}"]`).first().click()
    // The seeded session's turns are on screen: the drawer has the conversation.
    await expect(page.getByText('Fetch the catalog page.').first()).toBeVisible({ timeout: 30_000 })
  }

  async function gear(page: Page, item: string) {
    await page.getByRole('button', { name: 'Agent settings' }).click()
    await page.getByText(item, { exact: true }).click()
  }

  /** In RedAmon's skill picker (platform 1.1.0): choose the skill `ref` and start. */
  async function pick(page: Page, ref: string, tag?: string) {
    if (!WITH_PICKER) return
    const picker = page.getByRole('dialog', { name: 'Choose a skill' })
    await expect(picker).toBeVisible()
    const row = picker.getByTestId(`pick-${ref}`)
    await expect(row).toBeVisible({ timeout: 30_000 })
    await row.getByRole('radio').check()
    if (tag) await shot(page, `picker_${tag}`)
    await picker.getByRole('button', { name: 'Start' }).click()
    await expect(picker).toBeHidden()
  }

  /** One "Improve skill" run up to an approved version; returns the version number approved. */
  async function improveAndApprove(page: Page, from: number, tag: string): Promise<number> {
    await gear(page, 'Improve skill from this session')
    await pick(page, SQLI, tag)
    await expect(page.getByRole('dialog', { name: /Choose a model for Skiller/ })).toHaveCount(0)
    const job = page.getByRole('dialog', { name: 'Improve skill from this session' })
    await expect(job).toBeVisible()
    // The skill is named first, with the version that runs now (F-11).
    await expect(job.getByText(`${SQLI_LABEL} (${SQLI})`)).toBeVisible({ timeout: 30_000 })
    await expect(job.getByText(`v${from}`, { exact: true })).toBeVisible()
    await shot(page, `job_modal_${tag}`)
    const header = page.getByTestId('review-header')
    await expect(header).toBeVisible({ timeout: 120_000 })
    const m = /v(\d+) → v(\d+)/.exec((await header.innerText()).replace(/\s+/g, ' '))
    expect(m, await header.innerText()).not.toBeNull()
    expect(Number(m![1])).toBe(from)
    const to = Number(m![2])
    await expect(page.getByRole('heading', { name: new RegExp(`Skill: ${SQLI_LABEL}`) })).toBeVisible()
    await expect(page.getByTestId('textdiff-row').first()).toBeVisible()
    await shot(page, `review_modal_${tag}`)
    await page.getByRole('button', { name: new RegExp(`^Approve v${to}`) }).click()
    await page.getByText(/from the next message or resume/i).waitFor()
    await page.getByRole('button', { name: /^Approve$/ }).click()
    await expect(header).toBeHidden({ timeout: 30_000 })
    await expect.poll(async () => (await versions()).find((v) => v.status === 'active')?.revision).toBe(to)
    return to
  }

  test.beforeAll(async () => {
    if (!FROM_CATALOG && !SKILLER_FILES.every((f) => existsSync(join(SKILLER_DIST, f)))) return
    stub = spawn(process.execPath, [join(__dirname, '..', 'scripts', 'stub-llm-server.mjs'), '0', agentHost()], {
      env: { ...process.env, STUB_LLM_DELAY_MS: '5000' },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const port = await new Promise<number>((resolve, reject) => {
      stub!.stdout!.once('data', (d) => resolve(JSON.parse(String(d)).port))
      stub!.once('exit', (code) => reject(new Error(`the stub model exited (${code})`)))
    })
    const created = await api.post(`/api/users/${admin}/llm-providers`, {
      data: {
        providerType: 'openai_compatible',
        name: 'Skiller e2e stub',
        baseUrl: `http://host.docker.internal:${port}/v1`,
        modelIdentifier: 'skiller-stub',
        apiKey: 'stub-no-key',
      },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    providerId = ((await created.json()) as { id: string }).id
    ready = true
  })

  test.afterAll(async () => {
    if (api && ready) {
      const list = (await (await api.get('/api/plugins')).json()) as { plugins: { id: string; state: string }[] }
      if (list.plugins.some((p) => p.id === 'skiller' && p.state !== 'not_installed')) {
        await clearSkill(SQLI)
        await api.get('/api/plugins/skiller/export')
        await api.post('/api/plugins/skiller/uninstall', { data: { mode: 'purge', confirm: 'skiller' } })
      }
      await api.put(`/api/users/${admin}/settings`, {
        data: { featureModels: { 'plugin:skiller': '' } },
        headers: { 'Content-Type': 'application/json' },
      })
      if (providerId) await api.delete(`/api/users/${admin}/llm-providers/${providerId}`)
      for (const id of [sessionId, ...ownSessions].filter(Boolean)) {
        const conv = await api.get(`/api/conversations/by-session/${id}`)
        if (conv.ok()) await api.delete(`/api/conversations/${((await conv.json()) as { id: string }).id}`)
      }
      for (const id of ownSkills) await api.delete(`/api/users/${admin}/attack-skills/${id}`)
      if (savedToggles !== undefined && projectId) {
        await api.put(`/api/projects/${projectId}`, {
          data: { attackSkillConfig: savedToggles },
          headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    stub?.kill()
  })

  test('analyse a session from the chat menu, review and approve, twice', async ({ page }) => {
    test.setTimeout(600_000)
    test.skip(!ready, 'Pack and sign Skiller into SKILLER_DIST (see the comment above).')
    const projects = (await (await api.get('/api/projects')).json()) as { id: string }[]
    projectId = projects[0]?.id ?? ''
    test.skip(!projectId, 'No project to seed a session into.')

    await installSkiller(page)
    await clearSkill(SQLI)
    await setModel(`custom/${providerId}`)

    sessionId = `session_e2e_skiller_${Date.now().toString(16)}`
    const seeded = await api.post(`/api/conversations/by-session/${sessionId}/messages`, {
      data: { projectId, userId: admin, messages: SESSION.events },
      headers: { 'Content-Type': 'application/json', 'x-internal-key': envValue('INTERNAL_API_KEY') },
    })
    expect(seeded.status(), await seeded.text()).toBe(201)

    await openSession(page)
    firstLabel = await improveAndApprove(page, 1, 'first')
    expect(firstLabel).toBeGreaterThanOrEqual(2)
    const second = await improveAndApprove(page, firstLabel, 'second')
    expect(second).toBe(firstLabel + 1)
  })

  /** A session on the user skill `id` (whose text is `content`), with three built-in turns first. */
  async function seedUserSession(id: string, content: string): Promise<string> {
    const session = `session_e2e_skiller_user_${Date.now().toString(16)}`
    const events = JSON.parse(
      JSON.stringify(USER_SESSION.events).replaceAll('__USER_SKILL_ID__', id).replaceAll('__USER_SKILL_SHA16__', sha16(content)),
    )
    const seeded = await api.post(`/api/conversations/by-session/${session}/messages`, {
      data: { projectId, userId: admin, messages: events },
      headers: { 'Content-Type': 'application/json', 'x-internal-key': envValue('INTERNAL_API_KEY') },
    })
    expect(seeded.status(), await seeded.text()).toBe(201)
    ownSessions.push(session)
    return session
  }

  const ownSkillList = async () =>
    (await (await api.get(`/api/users/${admin}/attack-skills`)).json()) as {
      id: string; name: string; version: number | null; derivedFromName: string | null; pendingChangeSetIds: string[]
    }[]

  const projectToggles = async () =>
    (((await (await api.get(`/api/projects/${projectId}`)).json()) as { attackSkillConfig: { user?: Record<string, boolean> } })
      .attackSkillConfig.user ?? {})

  test('improve one of your own skills: saved as a new skill, used in the project instead of the old one', async ({ page }) => {
    test.setTimeout(600_000)
    test.skip(!ready || !firstLabel || !WITH_PICKER, 'Needs Skiller 1.1.0 installed by the first test.')
    const stamp = Date.now().toString(36)
    const name = `${USER_SESSION.skillName} ${stamp}`

    // The source skill, on in the project.
    const created = await api.post(`/api/users/${admin}/attack-skills`, {
      data: { name, description: USER_SESSION.skillDescription, content: USER_SESSION.skillContent },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(created.status(), await created.text()).toBe(201)
    const source = ((await created.json()) as { id: string }).id
    ownSkills.push(source)
    const project = (await (await api.get(`/api/projects/${projectId}`)).json()) as { attackSkillConfig: Record<string, unknown> }
    savedToggles = project.attackSkillConfig
    const on = await api.put(`/api/projects/${projectId}`, {
      data: { attackSkillConfig: { ...project.attackSkillConfig, user: { ...(await projectToggles()), [source]: true } } },
      headers: { 'Content-Type': 'application/json' },
    })
    expect(on.ok(), await on.text()).toBeTruthy()

    // The picker lists both skills of the session; pick the person's own.
    const first = await seedUserSession(source, USER_SESSION.skillContent)
    await openSession(page, first)
    await gear(page, 'Improve skill from this session')
    const picker = page.getByRole('dialog', { name: 'Choose a skill' })
    await expect(picker.getByTestId(`pick-${SQLI}`)).toContainText('Built-in')
    await expect(picker.getByTestId(`pick-user_skill:${source}`)).toContainText('Your skill')
    await pick(page, `user_skill:${source}`, 'user')

    // The job names the skill as the person's own.
    const job = page.getByRole('dialog', { name: 'Improve skill from this session' })
    await expect(job.getByText(`${name} (your skill)`)).toBeVisible({ timeout: 30_000 })

    // The review: a new skill, named v2 by default; a taken name is refused.
    const review = page.getByRole('dialog', { name: `New version of "${name}"` })
    await expect(review).toBeVisible({ timeout: 120_000 })
    const nameInput = review.getByLabel('Name', { exact: true })
    await expect(nameInput).toHaveValue(`${name} v2`)
    await nameInput.fill(name.toUpperCase())
    await expect(review.getByText(/You already have a skill with this name/)).toBeVisible()
    await expect(review.getByTestId('save-new-skill')).toBeDisabled()
    await nameInput.fill(`${name} v2`)
    await expect(review.getByText('✓ available')).toBeVisible()
    await expect(review.getByLabel(/^Use it in project/)).toBeChecked()
    await expect(review.getByLabel(new RegExp(`instead of "${name}"`))).toBeChecked()
    await shot(page, 'user_review')
    await review.getByTestId('save-new-skill').click()
    await expect(review).toBeHidden({ timeout: 30_000 })

    // An ordinary skill of the person's, on in the project in place of its source.
    const saved = (await ownSkillList()).find((s) => s.name === `${name} v2`)
    expect(saved).toBeTruthy()
    ownSkills.push(saved!.id)
    expect(saved!.version).toBe(2)
    expect(saved!.derivedFromName).toBe(name)
    const toggles = await projectToggles()
    expect(toggles[saved!.id]).toBe(true)
    expect(toggles[source]).toBe(false)
    await page.goto('/settings?tab=skills')
    const card = page.getByTestId(`user-skill-${saved!.id}`)
    await expect(card).toContainText(`v2 · from ${name}`)
    await shot(page, 'user_skill_saved')

    // A session on v2 suggests v3; the picker and the review fit a phone. The graph page itself
    // is not laid out for one, so the session is opened at desktop width and the window then shrinks.
    const v2Text = ((await (await api.get(`/api/users/${admin}/attack-skills/${saved!.id}`)).json()) as { content: string }).content
    const second = await seedUserSession(saved!.id, v2Text)
    await openSession(page, second)
    await gear(page, 'Improve skill from this session')
    await expect(picker).toBeVisible()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(picker.getByRole('button', { name: 'Start' })).toBeInViewport()
    await shot(page, 'picker_phone')
    await pick(page, `user_skill:${saved!.id}`)
    const review2 = page.getByRole('dialog', { name: `New version of "${name} v2"` })
    await expect(review2).toBeVisible({ timeout: 120_000 })
    await expect(review2.getByLabel('Name', { exact: true })).toHaveValue(`${name} v3`)
    await expect(review2.getByTestId('save-new-skill')).toBeInViewport()
    await shot(page, 'user_review_phone')
    await review2.getByRole('button', { name: 'Close', exact: true }).click()
    await page.setViewportSize({ width: 1280, height: 800 })

    // Deleting v2 would also delete its proposal waiting for review: the confirmation says so.
    await expect.poll(async () => (await ownSkillList()).find((s) => s.id === saved!.id)?.pendingChangeSetIds.length).toBe(1)
    await page.goto('/settings?tab=skills')
    await card.getByTitle('Delete').click()
    await expect(page.getByText('Its 1 proposal waiting for review is deleted too.')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Uninstalling Skiller says the saved skills are not affected, whether its data is kept or
    // deleted (the next test uninstalls).
    await page.goto('/plugins')
    await page.getByTestId('plugin-card-skiller').getByRole('button', { name: 'Uninstall' }).click()
    await expect(page.getByRole('dialog').getByText(/Skills people saved from its proposals as their own are not affected/)).toHaveCount(2)
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  })

  test('versions, delete, reset, numbers never reused, the model gate, uninstall and reinstall', async ({ page }) => {
    test.setTimeout(600_000)
    test.skip(!ready || !firstLabel, 'Needs the previous test.')
    const second = firstLabel + 1
    await openSession(page)

    // v1 factory, the first approval superseded, the second active.
    await gear(page, 'Skill versions')
    const modal = page.getByRole('dialog', { name: `Versions · ${SQLI_LABEL}` })
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('scope-user').getByTestId('version-factory')).toBeVisible()
    let rows = await versions()
    const older = rows.find((v) => v.revision === firstLabel)!
    const active = rows.find((v) => v.revision === second)!
    expect(older.status).toBe('superseded')
    expect(active.status).toBe('active')
    await shot(page, 'versions_modal')

    await modal.getByTestId(`version-${older.changeSetId}`).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click()
    await expect(modal.getByTestId(`version-${older.changeSetId}`)).toHaveCount(0)

    await modal.getByTestId(`version-${active.changeSetId}`).getByRole('button', { name: 'Reset to factory' }).click()
    await page.getByRole('button', { name: 'Reset', exact: true }).click()
    await expect.poll(async () => (await versions()).find((v) => v.changeSetId === active.changeSetId)?.status).not.toBe('active')
    await modal.getByTestId(`version-${active.changeSetId}`).getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).last().click()
    await expect.poll(async () => (await versions()).length).toBe(0)
    await shot(page, 'versions_modal_after_reset')
    await modal.getByRole('button', { name: 'Close modal' }).click()
    await expect(modal).toBeHidden()

    // The next version is numbered after every number used, never v2 again (TD-19, RV-04).
    const third = await improveAndApprove(page, 1, 'third')
    expect(third).toBe(second + 1)

    // Without a model, the action opens the model chooser instead of running (after the pick).
    await setModel('')
    await gear(page, 'Improve skill from this session')
    await pick(page, SQLI)
    const gate = page.getByRole('dialog', { name: /Choose a model for Skiller/ })
    await expect(gate).toBeVisible()
    await shot(page, 'model_gate')
    await gate.getByRole('button', { name: 'Close modal' }).click()
    await expect(gate).toBeHidden()

    // Uninstall keeping the data, reinstall restoring the approved version, uninstall deleting everything.
    await page.goto('/plugins')
    const card = page.getByTestId('plugin-card-skiller')
    await card.getByRole('button', { name: 'Uninstall' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Uninstall', exact: true }).click()
    await expect(card.getByTestId('plugin-state')).not.toHaveText('Ready', { timeout: 60_000 })
    await installSkiller(page)
    await expect.poll(async () => (await versions()).find((v) => v.status === 'active')?.revision).toBe(third)

    const list = (await (await api.get('/api/plugins')).json()) as { plugins: { id: string; inCatalog: boolean | null }[] }
    const inCatalog = list.plugins.find((p) => p.id === 'skiller')?.inCatalog
    // null means the catalog could not be read just now: what the purge leaves would be a guess.
    expect(inCatalog, 'the catalog must be readable before the purge').not.toBeNull()
    if (FROM_CATALOG) expect(inCatalog).toBe(true)
    const listed = inCatalog === true
    await card.getByRole('button', { name: 'Uninstall' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: /delete all data/i }).check()
    const download = page.waitForEvent('download')
    await dialog.getByRole('link', { name: /download the export/i }).click()
    expect((await download).suggestedFilename()).toMatch(/^redamon-plugin-skiller-.*\.json$/)
    await dialog.getByRole('textbox', { name: /type skiller/i }).fill('skiller')
    await dialog.getByRole('button', { name: 'Delete everything and uninstall' }).click()
    await expect(dialog).toBeHidden()
    // A purged plugin keeps its card, not installed, while the catalog in use lists it (the
    // official one has since skiller-v1.0.0, whichever way it was installed); otherwise it leaves none.
    if (listed) await expect(card.getByTestId('plugin-state')).toHaveText('Not installed', { timeout: 60_000 })
    else await expect(card).toHaveCount(0)
    rows = await versions()
    expect(rows).toEqual([])

    // A skill saved from Skiller's proposal is the person's own: the purge deletes only the
    // proposal records, never the skill.
    if (ownSkills.length > 1) {
      const kept = await ownSkillList()
      for (const id of ownSkills) expect(kept.some((s) => s.id === id), id).toBe(true)
      expect(kept.every((s) => s.pendingChangeSetIds.length === 0)).toBe(true)
    }
  })
})
