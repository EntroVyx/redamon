/**
 * The versions modal opened from Agent Skills inside the chat SettingsModal (X23, last
 * paragraph). The settings overlay closes on an outside click; the versions modal is a portal
 * whose React parent is the settings panel, so a click inside it is caught by the panel's
 * stopPropagation and does not close the settings overlay. Escape closes only the top modal,
 * and focus returns to the Versions button.
 *
 * @vitest-environment jsdom
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { AlertProvider, ToastProvider } from '@/components/ui'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: 'alice' }) }))
vi.mock('@/hooks/useDetectedHostIp', () => ({ useDetectedHostIp: () => null }))

import { SettingsModal } from './SettingsModal'
import type { ProjectFormData } from './hooks/useSettingsModal'

const APPLIED = { pluginId: 'skiller', pluginDisplayName: 'Skiller', scope: 'user', revision: 3, status: 'active', staleReason: null, applied: true, dormantReason: null }

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/overrides/summary')) return new Response(JSON.stringify({ projectId: 'p1', skills: [{ skillId: 'ssrf', applies: APPLIED, pending: 0 }] }), { status: 200 })
    if (url.includes('/overrides/versions')) return new Response(JSON.stringify({ skillId: 'ssrf', skillDisplayName: 'SSRF', factoryText: {}, registryError: null, scopes: [{ scopeType: 'user', scopeOwnerId: 'alice', factoryInUse: false, dormantReason: null, lastRevision: 3, versions: [] }] }), { status: 200 })
    if (url.includes('/plugins/contributions')) return new Response(JSON.stringify([]), { status: 200 })
    return new Response(JSON.stringify([]), { status: 200 })
  }))
}

function draw() {
  stub()
  const setSettingsModal = vi.fn()
  const data = { attackSkillConfig: { builtIn: { ssrf: true }, user: {} } } as unknown as ProjectFormData
  render(
    <ToastProvider>
      <AlertProvider>
        <SettingsModal settingsModal="attack" setSettingsModal={setSettingsModal} projectFormData={data} updateProjectField={vi.fn()} projectId="p1" />
      </AlertProvider>
    </ToastProvider>,
  )
  return { setSettingsModal }
}

beforeEach(() => {})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openVersions() {
  const versionsBtn = await within(await screen.findByTestId('plugin-skill-row-ssrf')).findByRole('button', { name: /versions/i })
  versionsBtn.focus() // jsdom does not focus on click; a browser would, which is what the modal restores to
  fireEvent.click(versionsBtn)
  await screen.findByText(/Versions ·/)
  return versionsBtn
}

describe('the versions modal over the settings overlay', () => {
  test('both are shown: the settings panel (Agent Skills) and the versions modal (role dialog)', async () => {
    draw()
    await openVersions()
    expect(screen.getByText('Agent Skills')).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('a click inside the versions modal does not close the settings overlay', async () => {
    const { setSettingsModal } = draw()
    await openVersions()
    fireEvent.click(screen.getByRole('dialog'))
    // The portal's React parent is the settings panel (stopPropagation), so the overlay's
    // close handler never fires.
    expect(setSettingsModal).not.toHaveBeenCalled()
  })

  test('Escape closes only the versions modal and leaves the settings overlay open; focus returns', async () => {
    const { setSettingsModal } = draw()
    const versionsBtn = await openVersions()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText(/Versions ·/)).toBeNull())
    expect(setSettingsModal).not.toHaveBeenCalled()
    expect(screen.getByText('Agent Skills')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(versionsBtn))
  })
})
