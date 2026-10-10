'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { bindText } from './bindings'
import type { Params } from './hostContext'
import styles from './host.module.css'

type BadgeNode = Extract<ScreenNode, { type: 'badge' }>

export function BadgePrimitive({ node, data }: { node: BadgeNode; data: Params }) {
  const text = bindText(node.content, data)
  if (!text) return null
  return (
    <span className={`${styles.badge} ${styles[`tone_${node.tone ?? 'neutral'}`]}`} data-testid="screen-badge">
      {text}
    </span>
  )
}
