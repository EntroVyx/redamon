/**
 * Pins the PhaseIndicatorBar as it was before plugins could add to its gear menu (phase 06
 * step 6.4 changes the component; this file was written and run green against the old one
 * first). The menu holds exactly Agent Behaviour, Tool Matrix and Agent Skills, in that
 * order, each opening its settings modal and closing the menu.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: 'user-1' }) }))
// No plugin contributions: this file pins the menu as it is without any plugin.
vi.mock('@/hooks/usePluginContributions', () => ({ usePluginContributions: () => ({ data: [] }) }))

import { PhaseIndicatorBar } from './PhaseIndicatorBar'
import { PHASE_CONFIG, formatModelDisplay } from './phaseConfig'

type Props = React.ComponentProps<typeof PhaseIndicatorBar>

function draw(over: Partial<Props> = {}) {
  const props: Props = {
    currentPhase: 'informational',
    toolPhaseMap: {},
    attackPathType: '',
    skillData: null,
    iterationCount: 0,
    stealthMode: false,
    settingsDropdownRef: { current: null },
    showSettingsDropdown: false,
    setShowSettingsDropdown: vi.fn(),
    setSettingsModal: vi.fn(),
    setShowModelModal: vi.fn(),
    ...over,
  }
  render(<PhaseIndicatorBar {...props} />)
  return props
}

const menuItems = () =>
  Array.from(screen.getByText('Agent Behaviour').parentElement!.children).map((el) => el.textContent)

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ servers: [] }), { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the gear menu', () => {
  test('closed: no menu items', () => {
    draw()
    expect(screen.queryByText('Agent Behaviour')).toBeNull()
  })

  test('the gear button toggles the menu', () => {
    const p = draw()
    fireEvent.click(screen.getByTitle('Agent settings'))
    expect(p.setShowSettingsDropdown).toHaveBeenCalledTimes(1)
    const toggle = (p.setShowSettingsDropdown as ReturnType<typeof vi.fn>).mock.calls[0][0] as (b: boolean) => boolean
    expect(toggle(false)).toBe(true)
    expect(toggle(true)).toBe(false)
  })

  test('open: exactly the three core items, in order', () => {
    draw({ showSettingsDropdown: true })
    expect(menuItems()).toEqual(['Agent Behaviour', 'Tool Matrix', 'Agent Skills'])
  })

  test.each([
    ['Agent Behaviour', 'agent'],
    ['Tool Matrix', 'toolmatrix'],
    ['Agent Skills', 'attack'],
  ])('%s opens the %s modal and closes the menu', (label, modal) => {
    const p = draw({ showSettingsDropdown: true })
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(p.setSettingsModal).toHaveBeenCalledWith(modal)
    expect(p.setShowSettingsDropdown).toHaveBeenCalledWith(false)
  })
})

describe('the rest of the bar', () => {
  test('the phase badge names the current phase', () => {
    draw({ currentPhase: 'exploitation' })
    expect(screen.getByText(PHASE_CONFIG.exploitation.label)).toBeInTheDocument()
  })

  test('the step count shows only once the agent has iterated', () => {
    draw({ iterationCount: 0 })
    expect(screen.queryByText(/^Step /)).toBeNull()
    cleanup()
    draw({ iterationCount: 3 })
    expect(screen.getByText('Step 3')).toBeInTheDocument()
  })

  test('stealth: a toggle when it can be changed, a badge when it cannot', () => {
    const onToggleStealth = vi.fn()
    draw({ stealthMode: false, onToggleStealth })
    fireEvent.click(screen.getByTitle(/Stealth Mode OFF/))
    expect(onToggleStealth).toHaveBeenCalledWith(true)
    cleanup()
    draw({ stealthMode: true })
    expect(screen.getByTitle(/passive\/low-noise techniques only/)).toBeInTheDocument()
  })

  test('the model badge shows the model and opens the picker', () => {
    const p = draw({ modelName: 'claude-opus-4-1' })
    const badge = screen.getByRole('button', { name: formatModelDisplay('claude-opus-4-1') })
    fireEvent.click(badge)
    expect(p.setShowModelModal).toHaveBeenCalledWith(true)
  })

  test('the user MCP servers are read for the tools tooltip', () => {
    draw()
    expect(fetch).toHaveBeenCalledWith('/api/users/user-1/mcp')
  })

  test('within the bar, the buttons are the gear and the model badge only (no plugin items)', () => {
    draw({ modelName: 'm' })
    const bar = screen.getByTitle('Agent settings').closest('div')!.parentElement!
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('title') ?? b.textContent)).toEqual([
      'Agent settings',
      formatModelDisplay('m'),
    ])
  })
})
