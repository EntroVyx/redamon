/**
 * The model gate for a plugin feature (TD-10, F-18, R-66): `plugin:<id>` is not a core
 * feature, so the gate never asks getLlmFeature about it (which throws) and takes the
 * label from the caller: "Choose a model for Skiller". A plugin has no excluded models.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { useEffect } from 'react'
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: 'user-1' }) }))

import {
  FeatureModelGate,
  FeatureModelGateProvider,
  FeatureModelLine,
  useFeatureModelGate,
  type FeatureModelGateApi,
} from './FeatureModelGate'

const MODELS = {
  Anthropic: [{ id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', context_length: 200000, description: '' }],
  'AWS Bedrock': [{ id: 'bedrock/anthropic.claude-3-5-sonnet', name: 'Bedrock Claude Sonnet', context_length: null, description: '' }],
}
let saved: Record<string, string>
const fetchMock = vi.fn()
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, clone() { return this } })

beforeEach(() => {
  saved = {}
  fetchMock.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/api/models') return json(200, MODELS)
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

let api: FeatureModelGateApi
function Capture() {
  const gate = useFeatureModelGate()
  useEffect(() => {
    api = gate
  })
  return null
}

const mount = () =>
  render(
    <FeatureModelGateProvider>
      <Capture />
    </FeatureModelGateProvider>,
  )

describe('the gate for a plugin feature', () => {
  test('ensureFeatureModel opens "Choose a model for Skiller" and saves plugin:skiller', async () => {
    mount()
    let picked: Promise<string | null>
    act(() => {
      picked = api.ensureFeatureModel('plugin:skiller', { label: 'Skiller', description: 'Reads a session.' })
    })
    expect(await screen.findByText('Choose a model for Skiller')).toBeTruthy()
    expect(screen.getByText('Reads a session.')).toBeTruthy()
    fireEvent.click(await screen.findByText('Choose a model'))
    expect(await screen.findByText('Bedrock Claude Sonnet')).toBeTruthy()
    fireEvent.click(screen.getByText('Claude Haiku 4.5'))
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect(await picked!).toBe('claude-haiku-4-5')
    expect(saved).toEqual({ 'plugin:skiller': 'claude-haiku-4-5' })
  })

  test('a saved plugin model is used without opening the gate', async () => {
    saved = { 'plugin:skiller': 'claude-haiku-4-5' }
    mount()
    let result: string | null = null
    await act(async () => {
      result = await api.ensureFeatureModel('plugin:skiller', { label: 'Skiller' })
    })
    expect(result).toBe('claude-haiku-4-5')
    expect(screen.queryByText('Choose a model for Skiller')).toBeNull()
  })

  test('fetchWithFeatureModel: model_required for the plugin opens its gate and retries once', async () => {
    mount()
    const doFetch = vi
      .fn()
      .mockResolvedValueOnce(json(409, { error: 'Choose a model for this plugin in Models by feature.', code: 'model_required', featureId: 'plugin:skiller' }))
      .mockResolvedValueOnce(json(200, { ok: true }))
    let res: Promise<Response>
    act(() => {
      res = api.fetchWithFeatureModel('plugin:skiller', doFetch as never, { label: 'Skiller' })
    })
    expect(await screen.findByText('Choose a model for Skiller')).toBeTruthy()
    fireEvent.click(await screen.findByText('Choose a model'))
    fireEvent.click(await screen.findByText('Claude Haiku 4.5'))
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }))
    expect((await res!).status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
  })

  test('without a label the gate still opens, naming "this plugin"', async () => {
    render(<FeatureModelGate featureId="plugin:skiller" userId="user-1" onSaved={() => {}} onCancel={() => {}} />)
    expect(await screen.findByText('Choose a model for this plugin')).toBeTruthy()
  })

  test('the model line for a plugin feature uses the caller’s label', async () => {
    saved = { 'plugin:skiller': 'claude-haiku-4-5' }
    render(
      <FeatureModelGateProvider>
        <FeatureModelLine featureId="plugin:skiller" featureLabel="Skiller" />
      </FeatureModelGateProvider>,
    )
    await waitFor(() => expect(screen.getByText('claude-haiku-4-5')).toBeTruthy())
    expect(screen.getByLabelText('Change the Skiller model')).toBeTruthy()
  })
})
