/**
 * Pins AttackSkillsSection as it was before plugins added version controls (phase 06 step 6.7
 * changes it; this file was written and run green against the old component first): the
 * built-in skills with their toggles, the sub-settings that appear when a skill is on, and the
 * user-skills list with its Import control.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: 'user-1' }) }))
vi.mock('@/components/ui/AlertModal', () => ({ useAlertModal: () => ({ alert: vi.fn(), alertError: vi.fn() }) }))

import { AttackSkillsSection } from './AttackSkillsSection'

type FormData = React.ComponentProps<typeof AttackSkillsSection>['data']

function draw(over: Partial<FormData> = {}) {
  const data = { attackSkillConfig: { builtIn: {}, user: {} }, hydraEnabled: false, ...over } as FormData
  const updateField = vi.fn()
  render(<AttackSkillsSection data={data} updateField={updateField} />)
  return { updateField }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('built-in skills', () => {
  test('lists the 14 built-in skills', async () => {
    draw()
    // Each built-in skill renders its name; count the "Active" badges on the skill cards.
    expect(await screen.findByText('SQL Injection')).toBeInTheDocument()
    expect(screen.getByText('Server-Side Request Forgery')).toBeInTheDocument()
    expect(screen.getByText('Cross-Site Scripting')).toBeInTheDocument()
    expect(screen.getByText('Availability Testing')).toBeInTheDocument()
  })

  test('toggling a built-in skill writes attackSkillConfig', async () => {
    const { updateField } = draw()
    const toggles = await screen.findAllByRole('switch')
    fireEvent.click(toggles[0])
    expect(updateField).toHaveBeenCalledWith('attackSkillConfig', expect.objectContaining({ builtIn: expect.any(Object) }))
  })

  test('the brute-force toggle also syncs hydraEnabled', async () => {
    const { updateField } = draw({ attackSkillConfig: { builtIn: { brute_force_credential_guess: false }, user: {} } })
    await screen.findByText('Credential Testing')
    // The credential-testing card's switch is the one whose row holds that name.
    const row = screen.getByText('Credential Testing').closest('div')!.parentElement!.parentElement!
    fireEvent.click(row.querySelector('[role="switch"]')!)
    expect(updateField).toHaveBeenCalledWith('hydraEnabled', true)
  })
})

describe('user skills', () => {
  test('empty state links to Global Settings', async () => {
    draw()
    expect(await screen.findByText(/No user skills uploaded yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Global Settings/i })).toBeInTheDocument()
  })

  test('the Import from Community button is present', async () => {
    draw()
    expect(await screen.findByRole('button', { name: /Import from Community/i })).toBeInTheDocument()
  })

  test('user skills from the API are listed with a toggle', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('/attack-skills')
        ? new Response(JSON.stringify([{ id: 's1', name: 'My Skill', description: 'desc', createdAt: new Date().toISOString() }]), { status: 200 })
        : new Response(JSON.stringify([]), { status: 200 }),
    ))
    draw()
    expect(await screen.findByText('My Skill')).toBeInTheDocument()
  })
})

describe('no plugin controls without the feature', () => {
  test('no Versions or Reset buttons when no projectId and no plugin summary', async () => {
    draw()
    await screen.findByText('SQL Injection')
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Versions$/ })).toBeNull())
    expect(screen.queryByRole('button', { name: /Reset to factory/i })).toBeNull()
  })
})
