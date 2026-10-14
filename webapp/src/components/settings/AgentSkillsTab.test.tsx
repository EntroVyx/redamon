/**
 * Global Settings → Agent Skills (plan Phase 0.B.4, 0.C.4, 4.5, 4.10-4.11, 5.1): the user's
 * own skills with the count "N of 1000", search over name and description, the version
 * badge, the "N proposals" chip that opens the review without a project, the duplicate-name
 * flag, the quarantine banner (Read / Release / Delete), the delete confirmation that counts
 * the proposals deleted with it, upload and rename with the name check, the community import
 * summary by reason, and a refetch when another window saves a version.
 */
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within, act } from '@testing-library/react'
import { AlertProvider, ToastProvider } from '@/components/ui'
import { AgentSkillsTab, importSummary, type UserSkillRow } from './AgentSkillsTab'
import { postUserSkillsChanged } from '@/lib/userSkillsChannel'

const h = vi.hoisted(() => ({
  requests: [] as { url: string; method: string; body: unknown }[],
  skills: [] as unknown[],
  responders: {} as Record<string, (req: { url: string; method: string; body: unknown }) => Response | undefined>,
  nameCheck: ((_name: string) => ({ available: true, suggestion: null })) as (name: string) => Record<string, unknown>,
}))

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const skill = (over: Partial<UserSkillRow> = {}): UserSkillRow => ({
  id: 'sk1', name: 'My SQLi flow', description: 'SQLi against the login form', createdAt: '2026-10-10T10:00:00.000Z',
  version: null, lineageRootId: null, derivedFromName: null, quarantinedAt: null, quarantineReason: null,
  pendingChangeSetIds: [], duplicateName: false, ...over,
})

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const req = { url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    h.requests.push(req)
    for (const [k, fn] of Object.entries(h.responders)) {
      if (url.includes(k)) {
        const r = fn(req)
        if (r) return r
      }
    }
    if (url.includes('/name-check')) return json(200, h.nameCheck(new URLSearchParams(url.split('?')[1]).get('name') ?? ''))
    if (url.includes('/change-sets/')) return json(404, { error: 'Not found' })
    if (/\/attack-skills$/.test(url) && method === 'GET') return json(200, h.skills)
    if (/\/attack-skills$/.test(url) && method === 'POST') return json(201, { id: 'sk_new', name: (req.body as { name: string }).name })
    if (/\/attack-skills\/[^/]+$/.test(url) && method === 'GET') return json(200, { id: 'x', name: 'x', content: '# The skill text' })
    if (method === 'DELETE' || method === 'PUT') return json(200, { ok: true })
    if (url.endsWith('/release')) return json(200, { released: true })
    return json(404, {})
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  h.requests = []
  h.skills = []
  h.responders = {}
  h.nameCheck = () => ({ available: true, suggestion: null })
})

function draw(skills: UserSkillRow[] = [skill()]) {
  h.skills = skills
  render(
    <ToastProvider>
      <AlertProvider>
        <AgentSkillsTab userId="alice" />
      </AlertProvider>
    </ToastProvider>,
  )
}

const listGets = () => h.requests.filter((r) => r.method === 'GET' && r.url === '/api/users/alice/attack-skills')
const card = (id: string) => screen.getByTestId(`user-skill-${id}`)
const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement

async function chooseFile(name: string, content: string) {
  const file = new File([content], name, { type: 'text/markdown' })
  await act(async () => {
    fireEvent.change(fileInput(), { target: { files: [file] } })
  })
  await screen.findByRole('heading', { name: 'Upload Attack Skill' })
}

describe('the list', () => {
  test('lists the skills with the count "N of 1000"', async () => {
    draw([skill(), skill({ id: 'sk2', name: 'Recon checklist', description: null })])
    expect(await screen.findByText('My SQLi flow')).toBeInTheDocument()
    expect(screen.getByText('Recon checklist')).toBeInTheDocument()
    expect(screen.getByTestId('skill-count').textContent).toBe('2 of 1000')
    expect(within(card('sk2')).getByText('No description')).toBeInTheDocument()
  })

  test('empty: the empty state and "0 of 1000"', async () => {
    draw([])
    expect(await screen.findByText(/No custom skills uploaded yet/)).toBeInTheDocument()
    expect(screen.getByTestId('skill-count').textContent).toBe('0 of 1000')
  })

  test('search matches the name and the description, case-insensitively', async () => {
    draw([
      skill({ id: 'a', name: 'SQLi flow', description: 'login form' }),
      skill({ id: 'b', name: 'Recon checklist', description: 'Find the SQL endpoints' }),
      skill({ id: 'c', name: 'XSS notes', description: null }),
    ])
    await screen.findByText('SQLi flow')
    const search = screen.getByLabelText('Search your skills')
    fireEvent.change(search, { target: { value: 'sql' } })
    expect(screen.getByTestId('user-skill-a')).toBeInTheDocument()
    expect(screen.getByTestId('user-skill-b')).toBeInTheDocument()
    expect(screen.queryByTestId('user-skill-c')).toBeNull()
    fireEvent.change(search, { target: { value: 'LOGIN' } })
    expect(screen.getByTestId('user-skill-a')).toBeInTheDocument()
    expect(screen.queryByTestId('user-skill-b')).toBeNull()
    fireEvent.change(search, { target: { value: 'nothing like it' } })
    expect(screen.getByText('No skill matches “nothing like it”.')).toBeInTheDocument()
    // The count is of all skills, not of the matches.
    expect(screen.getByTestId('skill-count').textContent).toBe('3 of 1000')
  })

  test('a saved version shows "v3 · from <source>"', async () => {
    draw([skill({ id: 'sk3', name: 'My SQLi flow v3', version: 3, lineageRootId: 'sk1', derivedFromName: 'My SQLi flow v2' })])
    const c = await screen.findByTestId('user-skill-sk3')
    expect(c.textContent).toContain('v3 · from My SQLi flow v2')
  })

  test('a version whose source was deleted shows only "v3"', async () => {
    draw([skill({ id: 'sk3', name: 'My SQLi flow v3', version: 3, derivedFromName: null })])
    const c = await screen.findByTestId('user-skill-sk3')
    expect(c.textContent).toContain('v3')
    expect(c.textContent).not.toContain('· from')
  })

  test('a plain upload has no version badge', async () => {
    draw([skill({ version: null })])
    const c = await screen.findByTestId('user-skill-sk1')
    expect(c.textContent).not.toMatch(/v\d/)
  })

  test('a duplicate name is flagged "Same name as another skill — rename one"', async () => {
    draw([skill({ id: 'a', duplicateName: true }), skill({ id: 'b', name: 'my sqli  flow', duplicateName: true }), skill({ id: 'c', name: 'Other' })])
    await screen.findByTestId('user-skill-a')
    expect(within(card('a')).getByText(/Same name as another skill — rename one/)).toBeInTheDocument()
    expect(within(card('b')).getByText(/Same name as another skill — rename one/)).toBeInTheDocument()
    expect(within(card('c')).queryByText(/Same name as another skill/)).toBeNull()
  })

  test('skill names are text, never markup', async () => {
    draw([skill({ name: '<img src=x onerror="alert(1)">' })])
    const c = await screen.findByTestId('user-skill-sk1')
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(c.querySelector('img')).toBeNull()
  })
})

describe('proposals', () => {
  test('"2 proposals" opens the review of the first one, without a project', async () => {
    draw([skill({ pendingChangeSetIds: ['cs_a', 'cs_b'] })])
    const chip = await within(await screen.findByTestId('user-skill-sk1')).findByRole('button', { name: /2 proposals/ })
    fireEvent.click(chip)
    await waitFor(() => expect(h.requests.some((r) => r.url.includes('/change-sets/'))).toBe(true))
    const get = h.requests.find((r) => r.url.includes('/change-sets/'))!
    expect(get.url).toBe('/api/plugins/overrides/change-sets/cs_a')
  })

  test('one proposal reads "1 proposal"; none shows no chip', async () => {
    draw([skill({ id: 'a', pendingChangeSetIds: ['cs_a'] }), skill({ id: 'b', name: 'B', pendingChangeSetIds: [] })])
    await screen.findByTestId('user-skill-a')
    expect(within(card('a')).getByRole('button', { name: /^1 proposal$/ })).toBeInTheDocument()
    expect(within(card('b')).queryByRole('button', { name: /proposal/ })).toBeNull()
  })
})

describe('quarantine', () => {
  const q = () => skill({ quarantinedAt: '2026-10-12T00:00:00.000Z', quarantineReason: 'plugin_version_revoked', originPluginId: 'skiller' })

  test('the banner says why, with Read (download), Release and Delete', async () => {
    draw([q()])
    const c = await screen.findByTestId('user-skill-sk1')
    const banner = within(c).getByRole('status')
    expect(banner.textContent).toMatch(/Quarantined\./)
    expect(banner.textContent).toMatch(/revoked by the plugin catalog/)
    expect(within(banner).getByRole('button', { name: /Read \(download\)/ })).toBeInTheDocument()
    expect(within(banner).getByRole('button', { name: 'Release' })).toBeInTheDocument()
    expect(within(banner).getByRole('button', { name: /Delete/ })).toBeInTheDocument()
  })

  test('no banner for a skill that is not quarantined', async () => {
    draw([skill()])
    const c = await screen.findByTestId('user-skill-sk1')
    expect(within(c).queryByRole('status')).toBeNull()
  })

  test('Read downloads the text as <name>.md', async () => {
    const createObjectURL = vi.fn(() => 'blob:skill')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const clicks: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this.download) })
    draw([q()])
    const banner = within(await screen.findByTestId('user-skill-sk1')).getByRole('status')
    fireEvent.click(within(banner).getByRole('button', { name: /Read \(download\)/ }))
    await waitFor(() => expect(clicks).toEqual(['My SQLi flow.md']))
    expect(h.requests.some((r) => r.url === '/api/users/alice/attack-skills/sk1' && r.method === 'GET')).toBe(true)
    expect(createObjectURL).toHaveBeenCalled()
  })

  test('Release asks with a danger confirm, then POSTs .../release and refetches', async () => {
    draw([q()])
    const banner = within(await screen.findByTestId('user-skill-sk1')).getByRole('status')
    const before = listGets().length
    fireEvent.click(within(banner).getByRole('button', { name: 'Release' }))
    expect(await screen.findByText(/Release "My SQLi flow"\? Read its text first/)).toBeInTheDocument()
    const confirmBtn = screen.getByRole('button', { name: 'I have read it, release' })
    expect(confirmBtn.className).toMatch(/btnDanger/)
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(h.requests.some((r) => r.url === '/api/users/alice/attack-skills/sk1/release' && r.method === 'POST')).toBe(true))
    await waitFor(() => expect(listGets().length).toBe(before + 1))
  })

  test('cancelling Release posts nothing', async () => {
    draw([q()])
    const banner = within(await screen.findByTestId('user-skill-sk1')).getByRole('status')
    fireEvent.click(within(banner).getByRole('button', { name: 'Release' }))
    await screen.findByText(/Release "My SQLi flow"\?/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText(/Release "My SQLi flow"\?/)).toBeNull())
    expect(h.requests.some((r) => r.url.endsWith('/release'))).toBe(false)
  })

  test('a refused Release shows the server error', async () => {
    h.responders['/release'] = () => json(403, { error: 'Only the owner can release a skill.' })
    draw([q()])
    const banner = within(await screen.findByTestId('user-skill-sk1')).getByRole('status')
    fireEvent.click(within(banner).getByRole('button', { name: 'Release' }))
    fireEvent.click(await screen.findByRole('button', { name: 'I have read it, release' }))
    expect(await screen.findByText('Only the owner can release a skill.')).toBeInTheDocument()
  })

  test('Delete in the banner deletes the skill after the confirmation', async () => {
    draw([q()])
    const banner = within(await screen.findByTestId('user-skill-sk1')).getByRole('status')
    fireEvent.click(within(banner).getByRole('button', { name: /Delete/ }))
    await screen.findByText(/Delete this skill\?/)
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(h.requests.some((r) => r.url === '/api/users/alice/attack-skills/sk1' && r.method === 'DELETE')).toBe(true))
  })
})

describe('delete', () => {
  test('the confirmation counts the proposals deleted with it', async () => {
    draw([skill({ pendingChangeSetIds: ['a', 'b'] })])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Delete'))
    expect(await screen.findByText('Delete this skill? It will be removed from all projects. Its 2 proposals waiting for review are deleted too.')).toBeInTheDocument()
  })

  test('one proposal: singular wording', async () => {
    draw([skill({ pendingChangeSetIds: ['a'] })])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Delete'))
    expect(await screen.findByText('Delete this skill? It will be removed from all projects. Its 1 proposal waiting for review is deleted too.')).toBeInTheDocument()
  })

  test('no proposals: no proposal sentence', async () => {
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Delete'))
    expect(await screen.findByText('Delete this skill? It will be removed from all projects.')).toBeInTheDocument()
  })

  test('confirming DELETEs it and refetches; cancelling does nothing', async () => {
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Delete'))
    await screen.findByText(/Delete this skill\?/)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByText(/Delete this skill\?/)).toBeNull())
    expect(h.requests.some((r) => r.method === 'DELETE')).toBe(false)
    const before = listGets().length
    fireEvent.click(within(card('sk1')).getByTitle('Delete'))
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(h.requests.filter((r) => r.method === 'DELETE').map((r) => r.url)).toEqual(['/api/users/alice/attack-skills/sk1']))
    await waitFor(() => expect(listGets().length).toBe(before + 1))
  })
})

describe('upload', () => {
  test('a chosen file opens the modal with its name (no .md), a 100-character limit and the name check', async () => {
    draw([])
    await screen.findByText(/No custom skills uploaded yet/)
    await chooseFile('Recon checklist.md', '# Recon\nStep 1.')
    const name = screen.getByLabelText('Skill Name') as HTMLInputElement
    expect(name.value).toBe('Recon checklist')
    expect(name.maxLength).toBe(100)
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).maxLength).toBe(500)
    await waitFor(() => expect(h.requests.some((r) => r.url.includes('/name-check'))).toBe(true))
    const qs = new URLSearchParams(h.requests.find((r) => r.url.includes('/name-check'))!.url.split('?')[1])
    expect(qs.get('name')).toBe('Recon checklist')
    expect(qs.has('sourceId')).toBe(false)
  })

  test('a very long file name is cut to 100 characters', async () => {
    draw([])
    await screen.findByText(/No custom skills uploaded yet/)
    await chooseFile(`${'x'.repeat(150)}.md`, 'text')
    expect((screen.getByLabelText('Skill Name') as HTMLInputElement).value).toHaveLength(100)
  })

  test('a taken name is refused inline with the suggestion and Upload is disabled', async () => {
    h.nameCheck = (n) => (n === 'Recon checklist' ? { available: false, reason: 'name_taken', suggestion: 'Recon checklist 2' } : { available: true, suggestion: null })
    draw([])
    await screen.findByText(/No custom skills uploaded yet/)
    await chooseFile('Recon checklist.md', 'text')
    expect(await screen.findByText('You already have a skill with this name. Try "Recon checklist 2".')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled()
  })

  test('Upload POSTs the name, description and content, then closes and refetches', async () => {
    draw([])
    await screen.findByText(/No custom skills uploaded yet/)
    await chooseFile('Recon checklist.md', '# Recon\nStep 1.')
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Recon steps  ' } })
    await waitFor(() => expect(h.requests.some((r) => r.url.includes('/name-check'))).toBe(true))
    const before = listGets().length
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() => expect(h.requests.some((r) => r.method === 'POST' && /\/attack-skills$/.test(r.url))).toBe(true))
    const post = h.requests.find((r) => r.method === 'POST' && /\/attack-skills$/.test(r.url))!
    expect(post.body).toEqual({ name: 'Recon checklist', description: 'Recon steps', content: '# Recon\nStep 1.' })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Upload Attack Skill' })).toBeNull())
    await waitFor(() => expect(listGets().length).toBe(before + 1))
  })

  test('a 409 name_taken at upload shows the message and pre-fills the suggestion', async () => {
    h.responders['/attack-skills'] = (req) => (req.method === 'POST' && /\/attack-skills$/.test(req.url)
      ? json(409, { code: 'name_taken', error: 'You already have a skill named "Recon checklist".', suggestion: 'Recon checklist 2' })
      : undefined)
    draw([])
    await screen.findByText(/No custom skills uploaded yet/)
    await chooseFile('Recon checklist.md', 'text')
    await waitFor(() => expect(h.requests.some((r) => r.url.includes('/name-check'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText('You already have a skill named "Recon checklist".')).toBeInTheDocument()
    await waitFor(() => expect((screen.getByLabelText('Skill Name') as HTMLInputElement).value).toBe('Recon checklist 2'))
    expect(screen.getByRole('heading', { name: 'Upload Attack Skill' })).toBeInTheDocument()
  })

  // 1000 cards make role queries slow in jsdom, so these read the DOM directly.
  const importButton = () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Import from Community'))!

  test('at 1000 skills Upload and Import are disabled', async () => {
    draw(Array.from({ length: 1000 }, (_, i) => skill({ id: `s${i}`, name: `Skill ${i}` })))
    await waitFor(() => expect(screen.getByTestId('skill-count').textContent).toBe('1000 of 1000'))
    expect(fileInput()).toBeDisabled()
    expect(importButton()).toBeDisabled()
    expect(fileInput().closest('label')!.getAttribute('title')).toMatch(/You have 1000 skills, the maximum/)
  }, 30_000)

  test('at 999 skills Upload is still enabled', async () => {
    draw(Array.from({ length: 999 }, (_, i) => skill({ id: `s${i}`, name: `Skill ${i}` })))
    await waitFor(() => expect(screen.getByTestId('skill-count').textContent).toBe('999 of 1000'))
    expect(fileInput()).toBeEnabled()
    expect(importButton()).toBeEnabled()
  }, 30_000)
})

describe('edit (rename)', () => {
  test('the Edit window renames: PUT with name and description, checked with exceptId', async () => {
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Edit name and description'))
    const name = (await screen.findByLabelText('Name')) as HTMLInputElement
    expect(name.value).toBe('My SQLi flow')
    expect(name.maxLength).toBe(100)
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('SQLi against the login form')
    fireEvent.change(name, { target: { value: 'SQLi login flow' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '' } })
    await waitFor(() => expect(h.requests.some((r) => r.url.includes('/name-check') && r.url.includes('SQLi+login+flow'))).toBe(true))
    const check = h.requests.filter((r) => r.url.includes('/name-check')).at(-1)!
    expect(new URLSearchParams(check.url.split('?')[1]).get('exceptId')).toBe('sk1')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.requests.some((r) => r.method === 'PUT')).toBe(true))
    const put = h.requests.find((r) => r.method === 'PUT')!
    expect(put.url).toBe('/api/users/alice/attack-skills/sk1')
    expect(put.body).toEqual({ name: 'SQLi login flow', description: null })
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Edit Skill' })).toBeNull())
  })

  test('a taken name from the check disables Save with the message', async () => {
    h.nameCheck = (n) => (n === 'Recon checklist' ? { available: false, reason: 'name_taken', suggestion: null } : { available: true, suggestion: null })
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Edit name and description'))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Recon checklist' } })
    expect(await screen.findByText('You already have a skill with this name.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  test('a 409 name_taken from the PUT is shown inline and the window stays open', async () => {
    h.responders['/attack-skills/sk1'] = (req) => (req.method === 'PUT' ? json(409, { code: 'name_taken', error: 'You already have a skill named "Recon checklist".', suggestion: 'Recon checklist 2' }) : undefined)
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Edit name and description'))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Recon checklist' } })
    await waitFor(() => expect(h.requests.some((r) => r.url.includes('/name-check') && r.url.includes('Recon+checklist'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('You already have a skill named "Recon checklist".')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Edit Skill' })).toBeInTheDocument()
  })

  test('an empty name disables Save', async () => {
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(within(card('sk1')).getByTitle('Edit name and description'))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '  ' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})

describe('community import', () => {
  test('the summary names each reason a skill was skipped', async () => {
    h.responders['/import-community'] = () => json(200, { imported: 3, skipped: 4, skippedBy: { duplicate: 2, limit: 1, fetchFailed: 1, tooLarge: 0, invalid: 0 }, total: 7 })
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    const before = listGets().length
    fireEvent.click(screen.getByRole('button', { name: /Import from Community/ }))
    expect(await screen.findByText('Imported 3 community skill(s); skipped 2 already in your skills, 1 over your 1000-skill limit, 1 could not be fetched.')).toBeInTheDocument()
    await waitFor(() => expect(listGets().length).toBe(before + 1))
  })

  test('a failed import shows the server error', async () => {
    h.responders['/import-community'] = () => json(502, { error: 'Failed to fetch community skills catalog from agent service' })
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    fireEvent.click(screen.getByRole('button', { name: /Import from Community/ }))
    expect(await screen.findByText('Failed to fetch community skills catalog from agent service')).toBeInTheDocument()
  })
})

describe('importSummary', () => {
  test('every reason, in order', () => {
    expect(importSummary({ imported: 1, skippedBy: { duplicate: 1, limit: 2, tooLarge: 3, fetchFailed: 4, invalid: 5 } }))
      .toBe('Imported 1 community skill(s); skipped 1 already in your skills, 2 over your 1000-skill limit, 3 too large, 4 could not be fetched, 5 not valid.')
  })
  test('nothing skipped', () => {
    expect(importSummary({ imported: 2, skippedBy: { duplicate: 0, limit: 0, fetchFailed: 0, tooLarge: 0, invalid: 0 } })).toBe('Imported 2 community skill(s).')
  })
  test('never calls every skip a duplicate', () => {
    const text = importSummary({ imported: 0, skipped: 2, skippedBy: { fetchFailed: 2 } })
    expect(text).not.toMatch(/duplicate|already in your skills/)
    expect(text).toContain('2 could not be fetched')
  })
  test('a server message wins', () => {
    expect(importSummary({ message: 'All community skills are already imported.' })).toBe('All community skills are already imported.')
  })
  test('a missing answer reads as 0 imported', () => {
    expect(importSummary({})).toBe('Imported 0 community skill(s).')
  })
})

describe('other windows', () => {
  test('a message on the user-skills channel refetches the list', async () => {
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    const before = listGets().length
    h.skills = [skill(), skill({ id: 'sk3', name: 'My SQLi flow v2', version: 2, derivedFromName: 'My SQLi flow' })]
    act(() => postUserSkillsChanged({ projectId: 'p1' }))
    expect(await screen.findByTestId('user-skill-sk3')).toBeInTheDocument()
    // Exactly-once delivery is pinned in userSkillsChannel.test.tsx.
    expect(listGets().length).toBeGreaterThan(before)
    expect(screen.getByTestId('skill-count').textContent).toBe('2 of 1000')
  })

  test('a message without a project refetches too', async () => {
    draw([skill()])
    await screen.findByTestId('user-skill-sk1')
    const before = listGets().length
    act(() => postUserSkillsChanged({}))
    await waitFor(() => expect(listGets().length).toBeGreaterThan(before))
  })
})
