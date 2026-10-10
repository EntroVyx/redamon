import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { mintToken, signIn } from './auth'

/**
 * The Plugins page end to end (README.PLUGINS.md §7.1, §9): open it from the header,
 * install the `echo` test plugin from files, disable, enable, uninstall keeping the data,
 * install again, uninstall deleting everything.
 *
 * Needs a stack with PLUGINS_ENABLED=true whose webapp trusts the throwaway key of
 * scripts/make-plugin-fixtures.mjs (run it once; it prints the PLUGINS_EXTRA_TRUSTED_KEYS
 * value for .env, then `./redamon.sh up`). Skipped when the platform is off.
 */

// Not under test-results/, which Playwright empties before the run: the key must survive it.
const FIXTURES = join(__dirname, '..', '.plugin-fixtures')
const SEED_USER = process.env.REDAMON_USER || 'cmrzlj3xk0000ob3vo67o3igg'
let admin = process.env.REDAMON_ADMIN_USER || ''
let api: APIRequestContext

test.beforeAll(async ({ playwright, baseURL }) => {
  execFileSync(process.execPath, [join(__dirname, '..', 'scripts', 'make-plugin-fixtures.mjs'), FIXTURES], { stdio: 'ignore' })
  const seed = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `redamon-auth=${mintToken(SEED_USER)}` } })
  if (!admin) {
    // Lifecycle routes read the role from the database: sign in as a user who really is an admin.
    const users = (await (await seed.get('/api/users')).json()) as { id: string; role: string }[]
    admin = users.find((u) => u.role === 'admin')?.id ?? ''
  }
  await seed.dispose()
  api = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { cookie: `redamon-auth=${mintToken(admin)}` } })
})

test.afterAll(async () => {
  await api?.dispose()
})

test.beforeEach(async ({ context, baseURL }) => {
  const status = await api.get('/api/plugins/status')
  test.skip(status.status() === 404, 'The plugin platform is off on this stack (PLUGINS_ENABLED).')
  test.skip(!admin, 'No admin user in this database.')
  await purgeEcho()
  await signIn(context, admin, baseURL!)
  await context.addInitScript(() => {
    localStorage.setItem('redamon-v2-onboarding', JSON.stringify({ version: '2026-03-28-v2', acceptedAt: new Date().toISOString() }))
    localStorage.setItem('redamon-github-star-dismissed', '1')
  })
})

/** Leaves no echo behind from an earlier run (the purge needs an export first). */
async function purgeEcho() {
  const list = await (await api.get('/api/plugins')).json()
  const echo = (list.plugins as { id: string; state: string }[]).find((p) => p.id === 'echo')
  if (!echo || echo.state === 'not_installed') return
  await api.get('/api/plugins/echo/export')
  const res = await api.post('/api/plugins/echo/uninstall', { data: { mode: 'purge', confirm: 'echo' } })
  expect(res.ok(), await res.text()).toBeTruthy()
}

async function installFromFiles(page: Page) {
  await page.getByRole('button', { name: /install from file/i }).click()
  const dialog = page.getByRole('dialog')
  const inputs = dialog.locator('input[type="file"]')
  await inputs.nth(0).setInputFiles(join(FIXTURES, 'echo-1.0.0.tar.gz'))
  await inputs.nth(1).setInputFiles(join(FIXTURES, 'catalog.json'))
  await inputs.nth(2).setInputFiles(join(FIXTURES, 'catalog.json.sig'))
  await expect(dialog.getByText(/sees this data while it works/)).toBeVisible()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: /^Install Echo 1\.0\.0/ }).click()
  await expect(dialog).toBeHidden({ timeout: 90_000 })
}

const echoCard = (page: Page) => page.getByTestId('plugin-card-echo')
const echoState = (page: Page) => echoCard(page).getByTestId('plugin-state')

test('install from files, disable, enable, uninstall keep, reinstall, uninstall purge', async ({ page }) => {
  test.setTimeout(240_000)
  await page.goto('/graph')
  // Leave only once /graph has drawn, as a user does: it publishes drawer offsets on <html>
  // while it is shown, and they must go with it or the details drawer below is 0 px tall.
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--drawer-bottom') !== '')
  await page.getByRole('link', { name: /^Plugins$/ }).click()
  await expect(page).toHaveURL(/\/plugins$/)
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible()
  await expect(page.getByText(/Global Settings → MCP Tool Plugins/)).toBeVisible()

  await installFromFiles(page)
  await expect(echoState(page)).toHaveText('Ready', { timeout: 60_000 })

  await echoCard(page).getByRole('button', { name: 'Details' }).click()
  await expect(page.getByTestId('plugin-versions')).toContainText('1.0.0')
  await expect(page.getByRole('link', { name: /export data/i })).toBeInViewport()
  await page.getByRole('button', { name: 'Close drawer' }).click()

  await echoCard(page).getByRole('button', { name: 'Disable' }).click()
  await page.getByRole('button', { name: 'Disable', exact: true }).last().click()
  await expect(echoState(page)).toHaveText('Disabled')

  await echoCard(page).getByRole('button', { name: 'Enable' }).click()
  await expect(echoState(page)).toHaveText('Ready', { timeout: 60_000 })

  await echoCard(page).getByRole('button', { name: 'Uninstall' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Uninstall', exact: true }).click()
  await expect(echoState(page)).toHaveText('Not installed')

  await installFromFiles(page)
  await expect(echoState(page)).toHaveText('Ready', { timeout: 60_000 })

  await echoCard(page).getByRole('button', { name: 'Uninstall' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /delete all data/i }).check()
  const download = page.waitForEvent('download')
  await dialog.getByRole('link', { name: /download the export/i }).click()
  expect((await download).suggestedFilename()).toMatch(/^redamon-plugin-echo-.*\.json$/)
  await dialog.getByRole('textbox', { name: /type echo/i }).fill('echo')
  await dialog.getByRole('button', { name: 'Delete everything and uninstall' }).click()
  await expect(dialog).toBeHidden()
  await expect(echoCard(page)).toHaveCount(0)
})

test('the echo nav page draws its screen under a strict CSP, with no violation', async ({ page }) => {
  test.setTimeout(180_000)
  const violations: string[] = []
  page.on('console', (m) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(m.text())) violations.push(m.text())
  })
  await page.goto('/plugins')
  await installFromFiles(page)
  await expect(echoState(page)).toHaveText('Ready', { timeout: 60_000 })

  // The nav entry is listed on the Plugins page, not in the global header.
  await page.getByRole('link', { name: 'Open Echo' }).click()
  await expect(page).toHaveURL(/\/plugins\/echo$/)
  await expect(page.getByRole('heading', { level: 1, name: 'Echo' })).toBeVisible()
  await expect(page.getByText('The Echo fixture plugin exists to test the plugin platform.')).toBeVisible()
  // list_items runs in the plugin runner and pages with {items, next} (TD-28).
  await expect(page.getByText('first', { exact: true })).toBeVisible({ timeout: 30_000 })

  const res = await page.request.get('/plugins/echo')
  const csp = res.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("connect-src 'self'")
  expect((await page.request.get('/graph')).headers()['content-security-policy']).toBeUndefined()

  // A screen the manifest does not list is a 404, whatever exists on disk.
  expect((await page.request.get('/plugins/echo/not-listed')).status()).toBe(404)
  expect(violations).toEqual([])
})
