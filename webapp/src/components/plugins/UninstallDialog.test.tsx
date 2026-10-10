/**
 * Uninstall (README.PLUGINS.md §9.6, D-70): "Keep data" is the default; deleting everything
 * is instance-wide (every user and project), so it needs the export downloaded first and the
 * plugin id typed.
 */
import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { UninstallDialog } from './UninstallDialog'

afterEach(() => cleanup())

function open(busy = false) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(<UninstallDialog isOpen pluginId="echo" pluginName="Echo" busy={busy} onConfirm={onConfirm} onCancel={onCancel} />)
  return { onConfirm, onCancel }
}
const confirm = () => screen.getByRole('button', { name: /uninstall|delete everything/i }) as HTMLButtonElement

describe('UninstallDialog', () => {
  test('keep data is the default and uninstalls at once', () => {
    const { onConfirm } = open()
    expect((screen.getByRole('radio', { name: /keep its data/i }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(confirm())
    expect(onConfirm).toHaveBeenCalledWith('keep')
  })

  test('deleting all data says it is for every user and project', () => {
    open()
    expect(screen.getByRole('radio', { name: /delete all data for every user and project/i })).toBeTruthy()
  })

  test('purge needs the export downloaded and the plugin id typed', () => {
    const { onConfirm } = open()
    fireEvent.click(screen.getByRole('radio', { name: /delete all data/i }))
    expect(confirm().disabled).toBe(true)
    const link = screen.getByRole('link', { name: /download the export/i }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/api/plugins/echo/export')
    fireEvent.change(screen.getByRole('textbox', { name: /type echo/i }), { target: { value: 'echo' } })
    expect(confirm().disabled).toBe(true)
    fireEvent.click(link)
    expect(confirm().disabled).toBe(false)
    fireEvent.change(screen.getByRole('textbox', { name: /type echo/i }), { target: { value: 'ech' } })
    expect(confirm().disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: /type echo/i }), { target: { value: 'echo' } })
    fireEvent.click(confirm())
    expect(onConfirm).toHaveBeenCalledWith('purge')
  })

  test('cancel', () => {
    const { onCancel, onConfirm } = open()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  test('busy disables the confirmation', () => {
    open(true)
    expect(confirm().disabled).toBe(true)
  })
})
