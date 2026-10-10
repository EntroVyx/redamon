import { execFileSync } from 'node:child_process'
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
 * Needs a stack with PLUGINS_ENABLED=true trusting the throwaway fixtures key (see
 * pluginsPage.spec.ts). Skipped when the platform is off.
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
    const users = (await (await seed.get('/api/users')).json()) as { id: string; role: string }[]
    admin = users.find((u) => u.role === 'admin')?.id ?? ''
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

/** Clears any user-scope version left by an earlier run, so the skill starts on factory text. */
async function resetSkill() {
  await api.post('/api/plugins/overrides/reset', {
    data: { point: 'skill.text', group: SKILL, scopeType: 'user', scopeOwnerId: admin },
    headers: { 'Content-Type': 'application/json' },
  })
}

test.beforeEach(async ({ context, baseURL }) => {
  const status = await api.get('/api/plugins/status')
  test.skip(status.status() === 404, 'The plugin platform is off on this stack (PLUGINS_ENABLED).')
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
  await resetSkill()

  const projects = (await (await api.get('/api/projects')).json()) as { id: string }[]
  projectId = projects[0]?.id ?? ''
  test.skip(!projectId, 'No project to open settings for.')

  // echo proposes the factory text plus one marker line for the chosen skill (user scope).
  const proposed = await api.post('/api/plugins/echo/actions/propose_override', {
    data: { context: { projectId }, params: { skill: SKILL, part: 'payload_reference', scope: 'user' } },
    headers: { 'Content-Type': 'application/json' },
  })
  expect(proposed.ok(), await proposed.text()).toBeTruthy()

  await page.goto(`/projects/${projectId}/settings`)
  const skillRow = page.getByTestId(`plugin-skill-row-${SKILL}`)
  await expect(skillRow).toBeVisible({ timeout: 30_000 })

  // One pending proposal → open the versions modal, then the review.
  await skillRow.getByRole('button', { name: /pending/i }).click()
  await expect(page.getByText(/Versions ·/)).toBeVisible()
  await page.getByRole('button', { name: /open review/i }).click()
  await expect(page.getByTestId('review-header')).toBeVisible()
  await expect(page.getByText(new RegExp(SKILL_LABEL, 'i'))).toBeVisible()
  await expect(page.getByTestId('textdiff-row').first()).toBeVisible()

  // Approve, confirm.
  await page.getByRole('button', { name: /^Approve v/ }).click()
  await page.getByText(/from the next message or resume/i).waitFor()
  await page.getByRole('button', { name: /^Approve$/ }).click()

  // The chip now shows the applied version.
  await expect(skillRow.getByTestId('plugin-skill-chip')).toContainText(/changed by Echo · v2/i, { timeout: 30_000 })

  // Reset to factory; the chip goes.
  await skillRow.getByRole('button', { name: /reset to factory/i }).click()
  await page.getByRole('button', { name: /^Reset$/ }).click()
  await expect(skillRow).toBeHidden({ timeout: 30_000 })

  await resetSkill()
})
