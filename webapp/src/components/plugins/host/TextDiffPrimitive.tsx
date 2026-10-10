'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { bindText } from './bindings'
import type { Params } from './hostContext'
import { TextDiff } from './TextDiff'
import styles from './host.module.css'

type TextDiffNode = Extract<ScreenNode, { type: 'textDiff' }>

export function TextDiffPrimitive({ node, data }: { node: TextDiffNode; data: Params }) {
  return (
    <section className={styles.block}>
      {node.title && <h3 className={styles.subtitle}>{node.title}</h3>}
      <TextDiff before={bindText(node.before, data)} after={bindText(node.after, data)} />
    </section>
  )
}
