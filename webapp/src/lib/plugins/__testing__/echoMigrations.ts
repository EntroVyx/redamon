/**
 * The `echo` fixture's data migrations (services/plugin_runner/tests/fixtures/plugins/echo/
 * migrations/*.py) as scripts for the fake runner, so the webapp's tests and the runner
 * contract cases see the same answers the real worker gives.
 */
import { FAKE_DELETE, type MigrationScript } from './fakeRunner'

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function valueError(message: string): Error {
  return Object.assign(new Error(message), { name: 'ValueError' })
}

export const ECHO_MIGRATIONS: Record<string, MigrationScript> = {
  'echo/0002_up': (row) => {
    const v = row.value
    if (isObj(v)) {
      if (v.raise) throw valueError('echo fixture: this row cannot be migrated')
      if (v.delete) return FAKE_DELETE
      if ('grow' in v) return { v: 2, blob: 'x'.repeat(Number(v.grow)) }
    }
    return { v: 2, data: v }
  },
  'echo/0002_down': (row) => {
    const v = row.value
    return isObj(v) && v.v === 2 && 'data' in v ? v.data : v
  },
  'echo/0003_up': (row) => {
    const v = row.value
    return isObj(v) ? { ...v, v: 3 } : { v: 3, data: v }
  },
}
