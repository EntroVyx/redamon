/**
 * The core versions modal (design §6 SkillVersionsModal): a skill selector, then the factory
 * row (always present, never deletable), each approved version with its status, pending
 * proposals, and the actions — View, Review again, Delete (non-active), Delete all old,
 * Reset to factory. Numbers skipped after a deletion are explained. Delete and Reset are their
 * own API calls carrying the scope owner id.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { AlertProvider, ToastProvider } from '@/components/ui'
import { SkillVersionsModal } from './SkillVersionsModal'
import type { VersionRow, VersionsModel } from '@/lib/plugins/versionsModel'

const h = vi.hoisted(() => ({ model: null as unknown, posts: [] as { url: string; body: unknown }[], deletes: [] as string[], responders: {} as Record<string, () => Response> }))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  h.posts = []
  h.deletes = []
  h.responders = {}
})

function version(over: Partial<VersionRow> = {}): VersionRow {
  return {
    changeSetId: 'cs_1',
    revision: 2,
    status: 'active',
    staleReason: null,
    pluginId: 'skiller',
    pluginDisplayName: 'Skiller',
    createdAt: '2026-10-01T10:00:00.000Z',
    decidedAt: '2026-10-01T10:00:00.000Z',
    note: 'A better version.',
    parts: [{ partId: 'workflow', value: 'New workflow text.' }],
    applied: true,
    ...over,
  }
}

function model(over: Partial<VersionsModel> = {}, scopeOver: Record<string, unknown> = {}): VersionsModel {
  return {
    skillId: 'ssrf',
    skillDisplayName: 'Server-Side Request Forgery',
    factoryText: { workflow: 'Factory workflow text.' },
    registryError: null,
    scopes: [
      {
        scopeType: 'user',
        scopeOwnerId: 'alice',
        factoryInUse: false,
        dormantReason: null,
        lastRevision: 2,
        versions: [version()],
        ...scopeOver,
      },
    ],
    ...over,
  }
}

function draw(m: VersionsModel = model(), props: Partial<React.ComponentProps<typeof SkillVersionsModal>> = {}) {
  h.model = m
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (method === 'GET') return new Response(JSON.stringify(h.model), { status: 200 })
    if (method === 'DELETE') {
      h.deletes.push(url)
      const key = Object.keys(h.responders).find((k) => url.includes(k))
      return key ? h.responders[key]() : new Response(JSON.stringify({ deleted: true }), { status: 200 })
    }
    h.posts.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const key = Object.keys(h.responders).find((k) => url.includes(k))
    return key ? h.responders[key]() : new Response(JSON.stringify({ cleared: true, revision: 2 }), { status: 200 })
  }))
  const onClose = vi.fn()
  render(
    <ToastProvider>
      <AlertProvider>
        <SkillVersionsModal projectId={null} initialSkill="ssrf" scopeOwnerId="alice" onClose={onClose} {...props} />
      </AlertProvider>
    </ToastProvider>,
  )
  return { onClose }
}

const userScope = () => screen.getByTestId('scope-user')

describe('rows', () => {
  test('the factory row is always present and not deletable', async () => {
    draw()
    const factory = await screen.findByTestId('version-factory')
    expect(factory.textContent).toMatch(/factory/i)
    expect(within(factory).queryByRole('button', { name: /^Delete$/ })).toBeNull()
  })

  test('the skill selector lists the 14 built-in skills and defaults to the initial one', async () => {
    draw()
    const select = (await screen.findByLabelText(/skill/i)) as HTMLSelectElement
    expect(select.value).toBe('ssrf')
    expect(select.querySelectorAll('option').length).toBe(14)
  })

  test('an active version shows "active", with no Delete until it is reset', async () => {
    draw()
    const row = await screen.findByTestId('version-cs_1')
    expect(row.textContent).toMatch(/active/i)
    expect(within(row).queryByRole('button', { name: /^Delete$/ })).toBeNull()
    expect(within(row).getByRole('button', { name: /reset to factory/i })).toBeInTheDocument()
  })

  test('factory in use when the active version is dormant: "not applied" with the reason', async () => {
    draw(model({}, { factoryInUse: true, dormantReason: 'disabled', versions: [version({ applied: false })] }))
    const row = await screen.findByTestId('version-cs_1')
    expect(row.textContent).toMatch(/not applied/i)
    expect(row.textContent).toMatch(/disabled/i)
    expect((await screen.findByTestId('version-factory')).textContent).toMatch(/in use/i)
  })
})

describe('delete and reset', () => {
  test('reset posts to the reset route with the scope owner id, then reloads', async () => {
    draw()
    fireEvent.click(await within(await screen.findByTestId('version-cs_1')).findByRole('button', { name: /reset to factory/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /reset/i }).pop()!)
    await waitFor(() => expect(h.posts.some((p) => p.url.includes('/overrides/reset'))).toBe(true))
    const post = h.posts.find((p) => p.url.includes('/overrides/reset'))!
    expect(post.body).toMatchObject({ point: 'skill.text', group: 'ssrf', scopeType: 'user', scopeOwnerId: 'alice' })
  })

  test('a superseded version can be deleted (dangerConfirm), carrying no plugin call', async () => {
    draw(model({}, { versions: [version({ changeSetId: 'cs_old', revision: 1, status: 'superseded', applied: false })] }))
    fireEvent.click(await within(await screen.findByTestId('version-cs_old')).findByRole('button', { name: /^Delete$/ }))
    fireEvent.click(screen.getAllByRole('button', { name: /delete/i }).pop()!)
    await waitFor(() => expect(h.deletes.some((u) => u.includes('cs_old'))).toBe(true))
  })

  test('Delete all old versions deletes every non-active approved row', async () => {
    draw(model({}, {
      versions: [
        version({ changeSetId: 'cs_active', revision: 3, status: 'active' }),
        version({ changeSetId: 'cs_a', revision: 2, status: 'superseded', applied: false }),
        version({ changeSetId: 'cs_b', revision: 1, status: 'superseded', applied: false }),
      ],
    }))
    fireEvent.click(await screen.findByRole('button', { name: /delete all old versions/i }))
    fireEvent.click(screen.getAllByRole('button', { name: /delete/i }).pop()!)
    await waitFor(() => expect(h.deletes.filter((u) => u.includes('cs_a') || u.includes('cs_b')).length).toBe(2))
    expect(h.deletes.some((u) => u.includes('cs_active'))).toBe(false)
  })
})

describe('stale and part-removed', () => {
  test('a stale (factory_changed) active version offers Review again', async () => {
    const onReviewAgain = vi.fn()
    draw(model({}, { factoryInUse: true, versions: [version({ status: 'stale', staleReason: 'factory_changed', applied: false })] }), { onReviewAgain })
    const row = await screen.findByTestId('version-cs_1')
    fireEvent.click(within(row).getByRole('button', { name: /review again/i }))
    expect(onReviewAgain).toHaveBeenCalledWith('cs_1')
  })

  test('a part_removed version shows its message, offers Delete and no Review again', async () => {
    draw(model({}, { factoryInUse: true, versions: [version({ status: 'stale', staleReason: 'part_removed', applied: false })] }))
    const row = await screen.findByTestId('version-cs_1')
    expect(row.textContent).toMatch(/a RedAmon update removed a part|part this version changed/i)
    expect(within(row).getByRole('button', { name: /^Delete$/ })).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: /review again/i })).toBeNull()
  })
})

describe('other states', () => {
  test('a pending proposal has Open review', async () => {
    const onOpenReview = vi.fn()
    draw(model({}, { factoryInUse: true, versions: [version({ changeSetId: 'cs_p', revision: null, status: 'proposed', applied: false })] }), { onOpenReview })
    fireEvent.click(await within(await screen.findByTestId('version-cs_p')).findByRole('button', { name: /open review/i }))
    expect(onOpenReview).toHaveBeenCalledWith('cs_p')
  })

  test('numbers skipped after a deletion are explained', async () => {
    draw(model({}, { lastRevision: 5, versions: [version({ revision: 2 })] }))
    expect(await screen.findByText(/numbers can skip|version numbers are never reused/i)).toBeInTheDocument()
  })

  test('empty: the empty state', async () => {
    draw(model({}, { factoryInUse: true, versions: [] }))
    expect(await screen.findByText(/no versions yet/i)).toBeInTheDocument()
  })

  test('View shows a read-only diff of the version against the factory text', async () => {
    draw()
    fireEvent.click(await within(await screen.findByTestId('version-cs_1')).findByRole('button', { name: /^View$/ }))
    await screen.findByText('New workflow text.')
    expect(screen.getAllByTestId('textdiff-row').length).toBeGreaterThan(0)
  })

  test('another user’s scope is never shown (the model simply does not include it)', async () => {
    draw()
    await screen.findByTestId('scope-user')
    expect(screen.queryByTestId('scope-project')).toBeNull()
    expect(userScope()).toBeInTheDocument()
  })
})
