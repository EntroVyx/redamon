/**
 * The browser-wide "your skills changed" notice (plan Phase 4.4 after-commit, 4.6):
 * postUserSkillsChanged reaches every useUserSkillsChanged listener in this tab, and the
 * other tabs through BroadcastChannel. It must work where BroadcastChannel is missing or
 * throws, and a same-tab listener must hear each post ONCE (every listener refetches).
 */
import { test, expect, vi, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { USER_SKILLS_CHANNEL, postUserSkillsChanged, useUserSkillsChanged, type UserSkillsChange } from './userSkillsChannel'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Listener({ onChange }: { onChange: (c: UserSkillsChange) => void }) {
  useUserSkillsChanged(onChange)
  return null
}

const settle = () => new Promise((r) => setTimeout(r, 30))
// The jsdom environment exposes Node's BroadcastChannel, which delivers across channel
// objects in the same thread as a browser does across tabs and within one.
const noChannel = typeof BroadcastChannel === 'undefined'

test('the channel name', () => {
  expect(USER_SKILLS_CHANNEL).toBe('redamon:user-skills')
})

test('a post reaches a same-tab listener with its payload', async () => {
  const onChange = vi.fn()
  render(<Listener onChange={onChange} />)
  act(() => postUserSkillsChanged({ projectId: 'p1' }))
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ projectId: 'p1' }))
})

test.skipIf(noChannel)('a same-tab listener hears each post exactly once', async () => {
  // BroadcastChannel delivers to every OTHER channel object with the same name, including
  // those in the same tab; the local fan-out must not add a second delivery on top.
  const onChange = vi.fn()
  render(<Listener onChange={onChange} />)
  act(() => postUserSkillsChanged({ projectId: 'p1' }))
  await settle()
  expect(onChange).toHaveBeenCalledTimes(1)
})

test('without BroadcastChannel a same-tab listener still hears the post, once', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  const onChange = vi.fn()
  render(<Listener onChange={onChange} />)
  act(() => postUserSkillsChanged({ projectId: null }))
  await settle()
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange).toHaveBeenCalledWith({ projectId: null })
})

test('a BroadcastChannel that throws does not break posting or listening', async () => {
  vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('blocked') } })
  const onChange = vi.fn()
  render(<Listener onChange={onChange} />)
  expect(() => act(() => postUserSkillsChanged({}))).not.toThrow()
  await settle()
  expect(onChange).toHaveBeenCalledTimes(1)
})

test('a post with no argument sends an empty change', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  const onChange = vi.fn()
  render(<Listener onChange={onChange} />)
  act(() => postUserSkillsChanged())
  expect(onChange).toHaveBeenCalledWith({})
})

test('every mounted listener hears it', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  const a = vi.fn()
  const b = vi.fn()
  render(<><Listener onChange={a} /><Listener onChange={b} /></>)
  act(() => postUserSkillsChanged({ projectId: 'p2' }))
  expect(a).toHaveBeenCalledWith({ projectId: 'p2' })
  expect(b).toHaveBeenCalledWith({ projectId: 'p2' })
})

test('an unmounted listener hears nothing more', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  const onChange = vi.fn()
  const { unmount } = render(<Listener onChange={onChange} />)
  unmount()
  act(() => postUserSkillsChanged({ projectId: 'p1' }))
  expect(onChange).not.toHaveBeenCalled()
})

test('the latest callback is the one called (no stale closure)', async () => {
  vi.stubGlobal('BroadcastChannel', undefined)
  const first = vi.fn()
  const second = vi.fn()
  const { rerender } = render(<Listener onChange={first} />)
  rerender(<Listener onChange={second} />)
  act(() => postUserSkillsChanged({ projectId: 'p1' }))
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledWith({ projectId: 'p1' })
})

test.skipIf(noChannel)('a message from another tab (another channel object) reaches the listener', async () => {
  const onChange = vi.fn()
  render(<Listener onChange={onChange} />)
  const otherTab = new BroadcastChannel(USER_SKILLS_CHANNEL)
  otherTab.postMessage({ projectId: 'p9' })
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({ projectId: 'p9' }))
  otherTab.close()
})

test.skipIf(noChannel)('a malformed message from another tab is read as an empty change', async () => {
  const onChange = vi.fn()
  render(<Listener onChange={onChange} />)
  const otherTab = new BroadcastChannel(USER_SKILLS_CHANNEL)
  otherTab.postMessage('not an object')
  await waitFor(() => expect(onChange).toHaveBeenCalledWith({}))
  otherTab.close()
})
