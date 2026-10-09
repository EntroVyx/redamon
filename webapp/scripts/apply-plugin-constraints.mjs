/**
 * Database-side invariants of the plugin platform tables (README.PLUGINS.md §7.4):
 * at most one active override per target, the allowed status values, and owner and
 * scope columns that point at exactly the owner they name.
 *
 * Prisma cannot express a partial unique index or a CHECK constraint, so they are
 * applied here, from the webapp entrypoint AFTER `db push`, on every boot, like
 * apply-engagement-immutability.mjs. Prisma ignores partial indexes when it reads the
 * database, so a push leaves the index alone, but it is still re-checked every boot.
 *
 * Never fatal: the stores in src/lib/plugins/ enforce the same rules inside their
 * transactions (and dev mode never runs this script), so this is the second wall.
 * Never silent either: when existing duplicates prevent the index, the duplicated
 * targets are logged.
 *
 * Names: `plugin_overrides_one_active` is not a name Prisma generates (`*_key`,
 * `*_idx`); a collision would make the fatal `db push` restart-loop the webapp. The
 * CHECK names end in a version number: to change a definition, add the next number;
 * LOWER numbers of the same family are dropped here, higher ones are left alone, so an
 * older image that restarts never removes a newer check.
 *
 * Owner and scope checks say IS NOT NULL explicitly: a NULL makes a CHECK expression
 * NULL, which Postgres lets through, and a row whose owner key is NULL would never be
 * deleted with its owner.
 */
import { PrismaClient } from '@prisma/client'

const INDEX = 'plugin_overrides_one_active'
const INDEX_SQL =
  `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON plugin_overrides ` +
  `(extension_point, scope_type, scope_id, target_key) WHERE status = 'active'`
// How pg_get_indexdef renders INDEX_SQL (schema prefix stripped before comparing).
const INDEX_DEF =
  `CREATE UNIQUE INDEX ${INDEX} ON plugin_overrides USING btree ` +
  `(extension_point, scope_type, scope_id, target_key) WHERE (status = 'active'::text)`

// Keep in step with PLUGIN_STATUSES (registry.ts) and OVERRIDE_STATUSES (overrides.ts);
// a vitest compares them.
const INSTALL_STATUSES = ['available', 'installing', 'ready', 'failed', 'incompatible', 'updating', 'uninstalling']
const OVERRIDE_STATUSES = ['proposed', 'active', 'rejected', 'withdrawn', 'superseded', 'stale', 'cleared']

const inList = (values) => values.map((v) => `'${v}'`).join(', ')

const CHECKS = [
  {
    table: 'plugin_installs',
    family: 'plugin_installs_status_ck',
    name: 'plugin_installs_status_ck1',
    check: `status IN (${inList(INSTALL_STATUSES)})`,
  },
  {
    table: 'plugin_overrides',
    family: 'plugin_overrides_status_ck',
    name: 'plugin_overrides_status_ck1',
    check: `status IN (${inList(OVERRIDE_STATUSES)})`,
  },
  {
    table: 'plugin_installs',
    family: 'plugin_installs_lease_ck',
    name: 'plugin_installs_lease_ck1',
    // A lease without an expiry would never expire; an expiry without an operation is noise.
    check: `(operation_id IS NULL) = (lease_expires_at IS NULL)`,
  },
  {
    table: 'plugin_data',
    family: 'plugin_data_owner_ck',
    name: 'plugin_data_owner_ck2',
    check:
      `(owner_type = 'user' AND user_id IS NOT NULL AND user_id = owner_id AND project_id IS NULL) OR ` +
      `(owner_type = 'project' AND project_id IS NOT NULL AND project_id = owner_id AND user_id IS NULL)`,
  },
  {
    table: 'plugin_overrides',
    family: 'plugin_overrides_scope_ck',
    name: 'plugin_overrides_scope_ck2',
    check:
      `(scope_type = 'user' AND user_id IS NOT NULL AND user_id = scope_id AND project_id IS NULL) OR ` +
      `(scope_type = 'project' AND project_id IS NOT NULL AND project_id = scope_id AND user_id IS NULL)`,
  },
]

const versionOf = (name) => Number(/(\d+)$/.exec(name)?.[1] ?? 0)

const normalize = (def) => def.replace(/\bpublic\./g, '').replace(/\s+/g, ' ').trim()

async function tablesPresent(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public.plugin_installs')::text AS i,
            to_regclass('public.plugin_data')::text AS d,
            to_regclass('public.plugin_overrides')::text AS o`
  )
  const r = rows[0] || {}
  return Boolean(r.i && r.d && r.o)
}

async function ensureOneActiveIndex(prisma) {
  const existing = await prisma.$queryRawUnsafe(
    `SELECT pg_get_indexdef(c.oid) AS def FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = 'public' AND c.relkind = 'i'`,
    INDEX
  )
  if (existing.length && normalize(existing[0].def) === normalize(INDEX_DEF)) {
    console.log(`[plugins] ${INDEX}: present`)
    return
  }
  if (existing.length) {
    console.warn(`[plugins] ${INDEX}: definition differs, recreating (was: ${existing[0].def})`)
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS ${INDEX}`)
  }
  try {
    await prisma.$executeRawUnsafe(INDEX_SQL)
    console.log(`[plugins] ${INDEX}: created`)
  } catch (err) {
    const dups = await prisma.$queryRawUnsafe(
      `SELECT extension_point, scope_type, scope_id, target_key, count(*)::int AS n
         FROM plugin_overrides WHERE status = 'active'
        GROUP BY 1, 2, 3, 4 HAVING count(*) > 1 ORDER BY 5 DESC LIMIT 10`
    )
    if (dups.length) {
      const keys = dups
        .map((d) => `${d.extension_point} ${d.scope_type}:${d.scope_id} ${d.target_key} (x${d.n})`)
        .join('; ')
      console.error(`[plugins] one-active index missing: duplicate active overrides for ${keys}`)
    } else {
      console.error(`[plugins] one-active index missing: ${err?.message || err}`)
    }
  }
}

async function ensureCheck(prisma, { table, family, name, check }) {
  const others = await prisma.$queryRawUnsafe(
    `SELECT conname FROM pg_constraint
      WHERE conrelid = $1::regclass AND contype = 'c' AND conname LIKE $2 AND conname <> $3`,
    table,
    `${family}%`,
    name
  )
  const older = others.filter(({ conname }) => /^\d+$/.test(conname.slice(family.length)) && versionOf(conname) < versionOf(name))
  for (const { conname } of older) {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${conname}`)
    console.log(`[plugins] ${table}: dropped superseded constraint ${conname}`)
  }
  const exists = () =>
    prisma.$queryRawUnsafe(`SELECT 1 FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`, table, name)
  const present = await exists()
  try {
    // A DO block so the existence check and the ALTER are one statement: two webapp
    // copies booting together cannot both add it.
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conrelid = '${table}'::regclass AND conname = '${name}'
        ) THEN
          ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${check});
        END IF;
      END $$`)
    console.log(`[plugins] ${table}: ${name} ${present.length ? 'present' : 'created'}`)
  } catch (err) {
    // Two copies booting together: the other one added it between our check and ADD.
    if ((await exists()).length) {
      console.log(`[plugins] ${table}: ${name} present`)
      return
    }
    console.error(`[plugins] ${table}: constraint ${name} missing: ${err?.message || err}`)
  }
}

async function main() {
  const prisma = new PrismaClient()
  try {
    if (!(await tablesPresent(prisma))) {
      console.error('[plugins] plugin tables absent after db push; constraints not applied')
      return
    }
    await ensureOneActiveIndex(prisma)
    for (const c of CHECKS) await ensureCheck(prisma, c)
  } catch (err) {
    console.error('[plugins] constraint script failed:', err?.message || err)
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
}

main()
