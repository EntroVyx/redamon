'use client'

import { Loader2 } from 'lucide-react'
import styles from './host.module.css'

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className={styles.loading}>
      <Loader2 size={14} className={styles.spin} aria-hidden /> {label}
    </div>
  )
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div className={styles.error} role="alert">
      {message}
    </div>
  )
}

export function Message({ message }: { message: string }) {
  return (
    <div className={styles.message} role="status">
      {message}
    </div>
  )
}
