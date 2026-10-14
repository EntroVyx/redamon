'use client'

import { useId, useState, type FormEvent } from 'react'
import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import { resultMessage } from './bindings'
import { useHost } from './hostContext'
import { ErrorBox, Message } from './StatusLine'
import { useCall } from './useCall'
import styles from './host.module.css'

type FormNode = Extract<ScreenNode, { type: 'form' }>
type Field = FormNode['fields'][number]
type Value = string | boolean

function initial(f: Field): Value {
  if (f.kind === 'checkbox') return f.default === true
  if (f.default === undefined || f.default === null) return ''
  return String(f.default)
}

/** What the action receives: text as text, numbers as numbers (empty → null), checkboxes as booleans. */
function typed(f: Field, v: Value): unknown {
  if (f.kind === 'checkbox') return v === true
  if (f.kind === 'number') return v === '' ? null : Number(v)
  return v
}

function problem(f: Field, v: Value): string | null {
  if (f.kind === 'checkbox') return f.required && v !== true ? `${f.label} is required` : null
  const s = String(v)
  if (f.required && s.trim() === '') return `${f.label} is required`
  if (f.kind === 'number' && s.trim() !== '' && !Number.isFinite(Number(s))) return `${f.label} must be a number`
  if (f.maxLength && s.length > f.maxLength) return `${f.label} must be at most ${f.maxLength} characters`
  return null
}

export function FormPrimitive({ node }: { node: FormNode }) {
  const { runAction, openScreen, inputs } = useHost()
  const id = useId()
  const [values, setValues] = useState<Record<string, Value>>(() =>
    Object.fromEntries(node.fields.map((f) => [f.name, initial(f)])),
  )
  const [problems, setProblems] = useState<Record<string, string>>({})
  const call = useCall()

  const set = (name: string, v: Value) => setValues((prev) => ({ ...prev, [name]: v }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const found: Record<string, string> = {}
    for (const f of node.fields) {
      const p = problem(f, values[f.name])
      if (p) found[f.name] = p
    }
    setProblems(found)
    if (Object.keys(found).length) return
    const params = { ...inputs, ...Object.fromEntries(node.fields.map((f) => [f.name, typed(f, values[f.name])])) }
    const r = await call.run(() => runAction(node.submit.action, params))
    if (!r.ok) return
    if (node.resultScreen) openScreen(node.resultScreen, r.value)
    else call.setMessage(resultMessage(r.value, 'Saved'))
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      {node.title && <h3 className={styles.subtitle}>{node.title}</h3>}
      {node.fields.map((f) => {
        const fid = `${id}-${f.name}`
        const v = values[f.name]
        return (
          <div key={f.name} className={f.kind === 'checkbox' ? styles.checkField : styles.field}>
            {f.kind === 'checkbox' ? (
              <>
                <input id={fid} type="checkbox" checked={v === true} onChange={(e) => set(f.name, e.target.checked)} />
                <label htmlFor={fid}>{f.label}</label>
              </>
            ) : (
              <>
                <label htmlFor={fid} className={styles.label}>
                  {f.label}
                </label>
                {f.kind === 'textarea' ? (
                  <textarea
                    id={fid}
                    className="textInput"
                    value={String(v)}
                    placeholder={f.placeholder}
                    onChange={(e) => set(f.name, e.target.value)}
                  />
                ) : f.kind === 'select' ? (
                  <select id={fid} className="textInput" value={String(v)} onChange={(e) => set(f.name, e.target.value)}>
                    {v === '' && <option value="">Choose…</option>}
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={fid}
                    className="textInput"
                    type="text"
                    inputMode={f.kind === 'number' ? 'decimal' : undefined}
                    value={String(v)}
                    placeholder={f.placeholder}
                    onChange={(e) => set(f.name, e.target.value)}
                  />
                )}
              </>
            )}
            {problems[f.name] && <span className={styles.fieldError}>{problems[f.name]}</span>}
          </div>
        )
      })}
      {call.error && <ErrorBox message={call.error} />}
      {call.message && <Message message={call.message} />}
      <div>
        <button type="submit" className="primaryButton" disabled={call.busy}>
          {call.busy ? 'Working…' : node.submit.label ?? 'Submit'}
        </button>
      </div>
    </form>
  )
}
