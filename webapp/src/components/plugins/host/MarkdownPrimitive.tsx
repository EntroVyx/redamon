'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { bindText } from './bindings'
import type { Params } from './hostContext'
import { SafeMarkdown } from './SafeMarkdown'
import styles from './host.module.css'

type MarkdownNode = Extract<ScreenNode, { type: 'markdown' }>

export function MarkdownPrimitive({ node, data }: { node: MarkdownNode; data: Params }) {
  const text = bindText(node.content, data)
  return text ? <SafeMarkdown className={styles.markdown}>{text}</SafeMarkdown> : null
}
