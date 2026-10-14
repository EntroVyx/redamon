/**
 * The Plugins page lists every enabled plugin's `nav` entry with an "Open" link to its page
 * (design §6: nav entries live there and at the top of the plugin's page, not in the global
 * header). Nothing is drawn when no plugin has one.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PluginNavLinks } from './PluginNavLinks'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function draw(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <PluginNavLinks />
    </QueryClientProvider>,
  )
}

const echo = {
  pluginId: 'echo',
  displayName: 'Echo',
  updating: false,
  nav: { label: 'Echo items', icon: 'list', screen: 'ui/home.json' },
  chatSessionActions: [],
  projectSkillsRow: [],
}
const skiller = { pluginId: 'skiller', displayName: 'Skiller', updating: false, chatSessionActions: [{ key: 'a' }], projectSkillsRow: [] }

describe('PluginNavLinks', () => {
  test('one Open link per plugin with a nav entry, with its badge', async () => {
    draw(200, [echo, skiller])
    const link = await screen.findByRole('link', { name: /open echo items/i })
    expect(link.getAttribute('href')).toBe('/plugins/echo')
    expect(screen.getByTitle('RedAmon plugin').textContent).toContain('Echo')
    expect(screen.queryByText(/skiller/i)).toBeNull()
  })

  test('an updating plugin says so', async () => {
    draw(200, [{ ...echo, updating: true }])
    expect(await screen.findByText(/updating/i)).toBeInTheDocument()
  })

  test('no nav entries: nothing', async () => {
    const { container } = draw(200, [skiller])
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })

  test('an answer that is not a list draws nothing and breaks nothing', async () => {
    const { container } = draw(200, { plugins: [], catalog: {} })
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })

  test('a failed request draws nothing and breaks nothing', async () => {
    const { container } = draw(500, { error: 'boom' })
    await new Promise((r) => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})
