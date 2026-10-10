/**
 * The consent prompt (README.PLUGINS.md §6.2, D-33, D-46): before anything is downloaded the
 * admin reads each permission the release asks for, in words that say what the plugin's code
 * will see or do (session:read says it sees the target data of the sessions it runs on), and
 * Install stays disabled until they tick the box. An update marks the new permissions and
 * warns when the data moves; a reinstall asks whether to restore approved versions.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import type { ComponentProps } from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ConsentDialog } from './ConsentDialog'
import { PERMISSION_TEXT } from '@/lib/plugins/permissions'

afterEach(() => cleanup())

const PERMS = (['session:read', 'llm:invoke', 'override:skill.text'] as const).map((id) => ({ id, ...PERMISSION_TEXT[id] }))

function open(props: Partial<ComponentProps<typeof ConsentDialog>> = {}) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <ConsentDialog isOpen mode="install" pluginName="Echo" version="1.0.0" permissions={PERMS} onConfirm={onConfirm} onCancel={onCancel} {...props} />,
  )
  return { onConfirm, onCancel }
}

const confirmButton = () => screen.getByRole('button', { name: /^(install|update)/i })

describe('ConsentDialog', () => {
  test('lists every permission with its consent text', () => {
    open()
    for (const p of PERMS) {
      expect(screen.getByText(p.title)).toBeTruthy()
      expect(screen.getByText(p.consent)).toBeTruthy()
    }
    expect(screen.getByText(/Echo 1\.0\.0/)).toBeTruthy()
  })

  test('the session:read text says the plugin code sees the target data', () => {
    expect(PERMISSION_TEXT['session:read'].consent).toMatch(/target data/)
    expect(PERMISSION_TEXT['session:read'].consent).toMatch(/plugin's code sees/)
  })

  test('Install is disabled until the box is ticked', () => {
    const { onConfirm } = open()
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(confirmButton())
    expect(onConfirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /I allow it/i }))
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledWith({ restoreOverrides: undefined })
  })

  test('a release with no permissions still needs the consent to run code on the host', () => {
    open({ permissions: [] })
    expect(screen.getByText(/asks for no permission/i)).toBeTruthy()
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true)
  })

  test('an update marks the permissions it adds and warns when the data moves', () => {
    open({ mode: 'update', version: '1.1.0', newPermissions: ['override:skill.text'], migratesData: true })
    const item = screen.getByText(PERMISSION_TEXT['override:skill.text'].title).closest('li')!
    expect(item.textContent).toMatch(/New/)
    const other = screen.getByText(PERMISSION_TEXT['session:read'].title).closest('li')!
    expect(other.textContent).not.toMatch(/New/)
    expect(screen.getByText(/moves the plugin's data/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /^update/i })).toBeTruthy()
  })

  test('a reinstall that finds approved versions asks whether to restore them', () => {
    const { onConfirm } = open({ restoreCount: 2 })
    expect(screen.getByText(/2 approved skill versions/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: /factory text/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /I allow it/i }))
    fireEvent.click(confirmButton())
    expect(onConfirm).toHaveBeenCalledWith({ restoreOverrides: false })
  })

  test('Cancel closes without consent', () => {
    const { onCancel, onConfirm } = open()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('while busy, nothing can be clicked twice', () => {
    open({ busy: true })
    fireEvent.click(screen.getByRole('checkbox', { name: /I allow it/i }))
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(true)
  })
})
