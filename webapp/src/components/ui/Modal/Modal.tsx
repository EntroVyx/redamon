'use client'

import { useEffect, useCallback, useId, useRef, ReactNode, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import styles from './Modal.module.css'

interface ModalProps {
  /** Whether the modal is open */
  isOpen: boolean
  /** Callback when modal should close */
  onClose: () => void
  /** Modal title */
  title?: string
  /** Modal content */
  children: ReactNode
  /** Footer content (typically buttons) */
  footer?: ReactNode
  /** Size variant */
  size?: 'small' | 'default' | 'large' | 'xlarge' | 'full'
  /** Whether clicking overlay closes the modal */
  closeOnOverlayClick?: boolean
  /** Whether pressing Escape closes the modal */
  closeOnEscape?: boolean
  /** Whether to show the close button */
  showCloseButton?: boolean
  /** Optional actions rendered in the header (between title and close button) */
  headerActions?: ReactNode
  /** Optional extra class applied to the modal container (e.g. for custom sizing) */
  className?: string
}

export function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  size = 'default',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  showCloseButton = true,
  headerActions,
  className,
}: ModalProps) {
  // Per instance: modals can be open together (an alert over a dialog), and a shared id
  // would name every one of them after the first title in the page.
  const titleId = useId()
  const modalRef = useRef<HTMLDivElement>(null)
  const previousActiveElement = useRef<HTMLElement | null>(null)
  const pressStartedOnOverlay = useRef(false)

  // Handle escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (closeOnEscape && e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [closeOnEscape, onClose]
  )

  const handleOverlayMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    pressStartedOnOverlay.current = e.target === e.currentTarget
  }, [])

  // A press that starts inside the dialog and is released over the backdrop
  // gets its click dispatched to their common ancestor - the overlay. That
  // happens on a text-selection drag, and on a plain click into a field when a
  // password manager draws its icon over it. Only a press that began on the
  // backdrop counts as "clicked outside".
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const startedOnOverlay = pressStartedOnOverlay.current
      pressStartedOnOverlay.current = false
      if (closeOnOverlayClick && startedOnOverlay && e.target === e.currentTarget) {
        onClose()
      }
    },
    [closeOnOverlayClick, onClose]
  )

  // Focus trap and body scroll lock
  useEffect(() => {
    if (isOpen) {
      // Store the currently focused element
      previousActiveElement.current = document.activeElement as HTMLElement

      // An autoFocus field inside has already taken focus by now; keep it there.
      if (!modalRef.current?.contains(document.activeElement)) {
        modalRef.current?.focus()
      }

      // Lock body scroll
      document.body.style.overflow = 'hidden'

      return () => {
        // Restore body scroll
        document.body.style.overflow = ''

        // Restore focus
        previousActiveElement.current?.focus()
      }
    }
  }, [isOpen])

  if (!isOpen) return null

  const sizeClass = {
    small: styles.modalSmall,
    default: '',
    large: styles.modalLarge,
    xlarge: styles.modalXLarge,
    full: styles.modalFull,
  }[size]

  const modalContent = (
    <div
      className={styles.overlay}
      onMouseDown={handleOverlayMouseDown}
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
      role="presentation"
    >
      <div
        ref={modalRef}
        className={`${styles.modal} ${sizeClass}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
      >
        {(title || showCloseButton) && (
          <div className={styles.header}>
            {title && (
              <h2 id={titleId} className={styles.title}>
                {title}
              </h2>
            )}
            {headerActions && <div style={{ marginLeft: 'auto', marginRight: '8px' }}>{headerActions}</div>}
            {showCloseButton && (
              <button
                type="button"
                className={styles.closeButton}
                onClick={onClose}
                aria-label="Close modal"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}

        <div className={styles.body}>{children}</div>

        {footer && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  )

  // Render in portal
  if (typeof document !== 'undefined') {
    return createPortal(modalContent, document.body)
  }

  return null
}
