'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { cellText } from './bindings'
import { RowActions } from './RowActions'
import { ErrorBox, Loading, Message } from './StatusLine'
import { useRowActions } from './useRowActions'
import { usePagedSource } from './useSource'
import styles from './host.module.css'

type TableNode = Extract<ScreenNode, { type: 'table' }>

export function TablePrimitive({ node }: { node: TableNode }) {
  const src = usePagedSource(node.source)
  const rows = useRowActions(src.reload)
  const hasActions = !!node.rowActions && node.rowActions.length > 0
  return (
    <section className={styles.block}>
      {node.title && <h3 className={styles.subtitle}>{node.title}</h3>}
      {rows.error && <ErrorBox message={rows.error} />}
      {rows.message && <Message message={rows.message} />}
      {src.status === 'loading' && <Loading />}
      {src.status === 'error' && <ErrorBox message={src.error ?? ''} />}
      {src.status === 'ready' && src.items.length === 0 && <div className={styles.empty}>{node.emptyText || 'Nothing to show.'}</div>}
      {src.status === 'ready' && src.items.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {node.columns.map((c) => (
                  <th key={c.field}>{c.label ?? c.field}</th>
                ))}
                {hasActions && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {src.items.map((item, i) => (
                <tr key={i} data-testid="screen-table-row">
                  {node.columns.map((c) => (
                    <td key={c.field}>{cellText(item[c.field], c.format)}</td>
                  ))}
                  {hasActions && (
                    <td>
                      <RowActions actions={node.rowActions!} row={item} disabled={rows.busy} onAction={rows.onAction} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
