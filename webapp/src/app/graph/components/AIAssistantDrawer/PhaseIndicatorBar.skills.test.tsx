/**
 * The chat drawer's "Agent Skills" tooltip reads the toggles the way the agent does (plan D9,
 * Phase 0.A.5, 0.B.4): a user skill is listed only when this project's config says `true`
 * (a missing key is off, and a user may have hundreds of skills), and a built-in skill shows
 * OFF unless its key is `true`.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'

vi.mock('@/providers/ProjectProvider', () => ({ useProject: () => ({ userId: 'user-1' }) }))
vi.mock('@/hooks/usePluginContributions', () => ({ usePluginContributions: () => ({ data: [] }) }))
// The tooltips open on hover; render their content inline so it can be read.
vi.mock('@/components/ui/Tooltip/Tooltip', () => ({
  Tooltip: ({ content, children }: { content: React.ReactNode; children: React.ReactNode }) => (
    <div>
      {children}
      <div data-testid="tooltip-content">{content}</div>
    </div>
  ),
}))

import { PhaseIndicatorBar } from './PhaseIndicatorBar'

type Props = React.ComponentProps<typeof PhaseIndicatorBar>
type SkillData = NonNullable<Props['skillData']>

function draw(skillData: SkillData, attackPathType = 'sql_injection') {
  const props: Props = {
    currentPhase: 'exploitation',
    toolPhaseMap: {},
    attackPathType,
    skillData,
    iterationCount: 0,
    stealthMode: false,
    settingsDropdownRef: { current: null },
    showSettingsDropdown: false,
    setShowSettingsDropdown: vi.fn(),
    setSettingsModal: vi.fn(),
    setShowModelModal: vi.fn(),
    projectId: 'p1',
    sessionId: 's1',
    conversationId: 'c1',
  }
  render(<PhaseIndicatorBar {...props} />)
}

/** The tooltip whose header is "Agent Skills". */
function skillsTooltip(): HTMLElement {
  const t = screen.getAllByTestId('tooltip-content').find((el) => el.textContent?.includes('Agent Skills'))
  if (!t) throw new Error('no Agent Skills tooltip')
  return t
}

/** The tooltip row holding a skill name. */
const row = (name: string) => within(skillsTooltip()).getByText(name).parentElement as HTMLElement

const BUILTIN = [
  { id: 'sql_injection', name: 'SQL Injection' },
  { id: 'xss', name: 'Cross-Site Scripting' },
  { id: 'ssrf', name: 'Server-Side Request Forgery' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ servers: [] }), { status: 200 })))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('user skills', () => {
  test('only skills set to true are listed; false and a missing key are not', () => {
    draw({
      builtIn: BUILTIN,
      user: [
        { id: 'on1', name: 'My SQLi flow v2' },
        { id: 'off1', name: 'Turned off' },
        { id: 'missing', name: 'Never toggled' },
        { id: 'on2', name: 'Recon checklist' },
      ],
      config: { builtIn: { sql_injection: true }, user: { on1: true, off1: false, on2: true } },
    })
    const t = skillsTooltip()
    expect(within(t).getByText('User Skills')).toBeInTheDocument()
    expect(within(t).getByText('My SQLi flow v2')).toBeInTheDocument()
    expect(within(t).getByText('Recon checklist')).toBeInTheDocument()
    expect(within(t).queryByText('Turned off')).toBeNull()
    expect(within(t).queryByText('Never toggled')).toBeNull()
  })

  test('a truthy non-boolean value is not "on"', () => {
    draw({
      builtIn: BUILTIN,
      user: [{ id: 'weird', name: 'Stringly on' }],
      config: { builtIn: {}, user: { weird: 'true' as unknown as boolean } },
    })
    expect(within(skillsTooltip()).queryByText('Stringly on')).toBeNull()
  })

  test('no skill on: no "User Skills" group at all', () => {
    draw({
      builtIn: BUILTIN,
      user: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      config: { builtIn: {}, user: {} },
    })
    expect(within(skillsTooltip()).queryByText('User Skills')).toBeNull()
  })

  test('the session\'s user skill is marked active', () => {
    draw({
      builtIn: BUILTIN,
      user: [{ id: 'on1', name: 'My SQLi flow v2' }, { id: 'on2', name: 'Other' }],
      config: { builtIn: {}, user: { on1: true, on2: true } },
    }, 'user_skill:on1')
    expect(row('My SQLi flow v2').className).toContain('skillTooltipItemActive')
    expect(row('Other').className).not.toContain('skillTooltipItemActive')
  })
})

describe('built-in skills', () => {
  test('OFF when the key is missing or false; no OFF when true', () => {
    draw({
      builtIn: BUILTIN,
      user: [],
      config: { builtIn: { sql_injection: true, xss: false }, user: {} },
    })
    expect(within(row('SQL Injection')).queryByText('OFF')).toBeNull()
    expect(within(row('Cross-Site Scripting')).getByText('OFF')).toBeInTheDocument()
    expect(within(row('Server-Side Request Forgery')).getByText('OFF')).toBeInTheDocument()
    expect(row('Server-Side Request Forgery').className).toContain('skillTooltipItemDisabled')
  })

  test('every built-in is listed, on or off', () => {
    draw({ builtIn: BUILTIN, user: [], config: { builtIn: {}, user: {} } })
    for (const s of BUILTIN) expect(within(skillsTooltip()).getByText(s.name)).toBeInTheDocument()
    expect(within(skillsTooltip()).getAllByText('OFF')).toHaveLength(3)
  })
})
