/**
 * Models by feature shows one tile per plugin the user can choose a model for (F-16,
 * F-17, D-47): after the core tiles, badged "plugin", "Not set" by default, saved under
 * `plugin:<id>` like any feature. When its list fails the section is exactly as before.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import { ToastProvider } from '@/components/ui/Toast/Toast'
import { FeatureModelsSection } from './FeatureModelsSection'
import { LLM_FEATURES } from '@/lib/llmFeatures'

const MODELS = {
  Anthropic: [
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', context_length: 200000, description: '' },
  ],
  'AWS Bedrock': [
    { id: 'bedrock/anthropic.claude-3-5-sonnet', name: 'Bedrock Claude Sonnet', context_length: null, description: '' },
  ],
}
const SKILLER = {
  featureId: 'plugin:skiller',
  pluginId: 'skiller',
  label: 'Skiller',
  description: 'Reads a finished session and proposes better skill text.',
}

let saved: Record<string, string>
let pluginFeatures: { status: number; body: unknown }
const fetchMock = vi.fn()
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

beforeEach(() => {
  saved = {}
  pluginFeatures = { status: 200, body: [SKILLER] }
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/models') return json(200, MODELS)
    if (url === '/api/plugins/llm-features') return json(pluginFeatures.status, pluginFeatures.body)
    if (url === '/api/users/user-1/settings' && method === 'GET') return json(200, { featureModels: { ...saved } })
    if (url === '/api/users/user-1/settings' && method === 'PUT') {
      for (const [k, v] of Object.entries(JSON.parse(init!.body as string).featureModels as Record<string, string>)) {
        if (v) saved[k] = v
        else delete saved[k]
      }
      return json(200, { featureModels: { ...saved } })
    }
    return json(404, {})
  })
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const renderSection = () =>
  render(
    <ToastProvider>
      <FeatureModelsSection userId="user-1" providersCount={1} providersLoading={false} />
    </ToastProvider>,
  )

const pluginTile = async () => {
  await screen.findByText('Skiller')
  return document.querySelector('[data-feature="plugin:skiller"]') as HTMLElement
}

describe('plugin tiles', () => {
  test('one tile after the core tiles: label, plugin badge, Not set, description', async () => {
    renderSection()
    const tile = await pluginTile()
    expect(tile).not.toBeNull()
    expect(within(tile).getByText('Skiller')).toBeTruthy()
    expect(within(tile).getByText('plugin')).toBeTruthy()
    expect(within(tile).getByText('Not set')).toBeTruthy()
    expect(within(tile).getByText(SKILLER.description)).toBeTruthy()
    const order = [...document.querySelectorAll('[data-feature]')].map((e) => e.getAttribute('data-feature'))
    expect(order).toEqual([...LLM_FEATURES.map((f) => f.id), 'plugin:skiller'])
  })

  test('choosing a model saves plugin:<id> and the chip follows; a plugin lists every model', async () => {
    renderSection()
    const tile = await pluginTile()
    fireEvent.click(within(tile).getByText('Choose a model'))
    expect(await screen.findByText('Bedrock Claude Sonnet')).toBeTruthy()
    fireEvent.click(screen.getByText('Claude Haiku 4.5'))
    await waitFor(() => expect(saved['plugin:skiller']).toBe('claude-haiku-4-5'))
    const put = fetchMock.mock.calls.find(([u, i]) => u === '/api/users/user-1/settings' && i?.method === 'PUT')!
    expect(JSON.parse(put[1].body).featureModels).toEqual({ 'plugin:skiller': 'claude-haiku-4-5' })
    await waitFor(() => expect(within(tile).getByText('Set')).toBeTruthy())
  })

  test('a saved model can be cleared', async () => {
    saved = { 'plugin:skiller': 'claude-haiku-4-5' }
    renderSection()
    const tile = await pluginTile()
    fireEvent.click(await within(tile).findByLabelText('Clear the Skiller model'))
    await waitFor(() => expect(saved['plugin:skiller']).toBeUndefined())
  })

  test.each([
    ['fails', { status: 500, body: {} }],
    ['answers something that is not a list', { status: 200, body: { features: [] } }],
  ])('when the list %s: no plugin tile, the core tiles as before', async (_n, answer) => {
    pluginFeatures = answer
    renderSection()
    await screen.findByText(LLM_FEATURES[0].label)
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/plugins/llm-features')).toBe(true))
    expect(document.querySelectorAll('[data-feature]')).toHaveLength(LLM_FEATURES.length)
    expect(screen.queryByText('plugin')).toBeNull()
  })

  test('entries that are not plugin features are ignored', async () => {
    pluginFeatures = { status: 200, body: [{ ...SKILLER, featureId: 'triage' }, { label: 'x' }, SKILLER] }
    renderSection()
    await pluginTile()
    expect(document.querySelectorAll('[data-feature="triage"]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-feature^="plugin:"]')).toHaveLength(1)
  })
})
