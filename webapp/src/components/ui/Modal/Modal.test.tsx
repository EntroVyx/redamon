import { describe, test, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import React from 'react'
import { Modal } from './Modal'

afterEach(cleanup)

function renderModal(onClose = vi.fn()) {
  render(
    <Modal isOpen onClose={onClose} title="Create User">
      <input placeholder="email" autoFocus />
    </Modal>
  )
  const overlay = screen.getByRole('dialog').parentElement as HTMLElement
  return { onClose, overlay, input: screen.getByPlaceholderText('email') }
}

describe('Modal: backdrop close', () => {
  test('a press that starts and ends on the backdrop closes it', () => {
    const { onClose, overlay } = renderModal()
    fireEvent.mouseDown(overlay)
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Browsers dispatch the click to the common ancestor of the mousedown and
  // mouseup targets, so a press inside a field released over the backdrop
  // arrives as a click whose target IS the overlay.
  test('a press that starts inside the dialog and ends on the backdrop does not close it', () => {
    const { onClose, overlay, input } = renderModal()
    fireEvent.mouseDown(input)
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('a click with no press on the backdrop does not close it', () => {
    const { onClose, overlay } = renderModal()
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()
  })

  test('a stale backdrop press does not arm a later click', () => {
    const { onClose, overlay, input } = renderModal()
    fireEvent.mouseDown(overlay)
    fireEvent.click(overlay)
    fireEvent.mouseDown(input)
    fireEvent.click(overlay)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('closeOnOverlayClick=false never closes from the backdrop', () => {
    const onClose = vi.fn()
    render(
      <Modal isOpen onClose={onClose} closeOnOverlayClick={false}>
        <p>body</p>
      </Modal>
    )
    const overlay = screen.getByRole('dialog').parentElement as HTMLElement
    fireEvent.mouseDown(overlay)
    fireEvent.click(overlay)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Modal: initial focus', () => {
  test('keeps focus on an autoFocus field instead of pulling it to the dialog', () => {
    const { input } = renderModal()
    expect(document.activeElement).toBe(input)
  })

  test('focuses the dialog when nothing inside claims focus', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Info">
        <p>body</p>
      </Modal>
    )
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
})

describe('Modal: its accessible name', () => {
  test('two modals open at once are each named by their own title', () => {
    // A refusal alert opens over the dialog that asked: each must announce its own title.
    render(
      <>
        <Modal isOpen onClose={vi.fn()} title="Install Echo">
          <p>body</p>
        </Modal>
        <Modal isOpen onClose={vi.fn()} title="The plugin operation was refused">
          <p>why</p>
        </Modal>
      </>
    )
    expect(screen.getByRole('dialog', { name: 'Install Echo' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'The plugin operation was refused' })).toBeTruthy()
  })
})
