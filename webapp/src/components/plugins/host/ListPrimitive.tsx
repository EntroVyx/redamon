'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { valueText } from './bindings'
import { RowActions } from './RowActions'
import { ErrorBox, Loading, Message } from './StatusLine'
import { useRowActions } from './useRowActions'
import { usePagedSource } from './useSource'
import styles from './host.module.css'

type ListNode = Extract<ScreenNode, { type: 'list' }>

export function ListPrimitive({ node }: { node: ListNode }) {
  const src = usePagedSource(node.source)
  const rows = useRowActions(src.reload)
  return (
    <section className={styles.block}>
      {node.title && <h3 className={styles.subtitle}>{node.title}</h3>}
      {rows.error && <ErrorBox message={rows.error} />}
      {rows.message && <Message message={rows.message} />}
      {src.status === 'loading' && <Loading />}
      {src.status === 'error' && <ErrorBox message={src.error ?? ''} />}
      {src.status === 'ready' && src.items.length === 0 && <div className={styles.empty}>{node.emptyText || 'Nothing to show.'}</div>}
      {src.status === 'ready' && src.items.length > 0 && (
        <ul className={styles.list}>
          {src.items.map((item, i) => (
            <li key={i} className={styles.listItem} data-testid="screen-list-item">
              <div className={styles.listText}>
                <span className={styles.itemTitle}>{valueText(item[node.itemTitle])}</span>
                {node.itemSubtitle && <span className={styles.itemSubtitle}>{valueText(item[node.itemSubtitle])}</span>}
              </div>
              {node.rowActions && node.rowActions.length > 0 && (
                <RowActions actions={node.rowActions} row={item} disabled={rows.busy} onAction={rows.onAction} />
              )}
            </li>
          ))}
        </ul>
      )}
      {src.moreError && <ErrorBox message={src.moreError} />}
      {src.status === 'ready' && src.hasMore && (
        <button type="button" className="secondaryButton" onClick={src.loadMore} disabled={src.loadingMore}>
          {src.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  )
}
