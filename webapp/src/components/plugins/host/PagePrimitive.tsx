'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { useHost, type Params } from './hostContext'
import { ErrorBox, Loading } from './StatusLine'
import { useObjectSource } from './useSource'
import styles from './host.module.css'

type PageNode = Extract<ScreenNode, { type: 'page' }>

export function PagePrimitive({ node, data }: { node: PageNode; data: Params }) {
  const { renderNode } = useHost()
  const source = useObjectSource(node.source)
  return (
    <section className={styles.page}>
      {node.title && <h2 className={styles.title}>{node.title}</h2>}
      {source.status === 'loading' && <Loading />}
      {source.status === 'error' && <ErrorBox message={source.error} />}
      {source.status === 'ready' && node.children.map((child, i) => renderNode(child, { ...data, ...source.data }, i))}
    </section>
  )
}
