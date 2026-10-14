'use client'

import { Puzzle } from 'lucide-react'
import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import styles from './host.module.css'

type EmptyStateNode = Extract<ScreenNode, { type: 'emptyState' }>

export function EmptyStatePrimitive({ node }: { node: EmptyStateNode }) {
  return (
    <div className={styles.emptyState}>
      <Puzzle size={20} aria-hidden />
      <div className={styles.emptyTitle}>{node.title}</div>
      {node.text && <div className={styles.emptyText}>{node.text}</div>}
    </div>
  )
}
