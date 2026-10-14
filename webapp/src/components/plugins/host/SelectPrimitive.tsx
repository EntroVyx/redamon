'use client'

import { useId, useState } from 'react'
import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import styles from './host.module.css'

type SelectNode = Extract<ScreenNode, { type: 'select' }>

/** A choice outside a form. Platform 1.0 binds it to nothing; it holds the viewer's choice. */
export function SelectPrimitive({ node }: { node: SelectNode }) {
  const id = useId()
  const [value, setValue] = useState(node.default ?? node.options[0]?.value ?? '')
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {node.label}
      </label>
      <select id={id} name={node.name} className="textInput" value={value} onChange={(e) => setValue(e.target.value)}>
        {node.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  )
}
