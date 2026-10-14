/**
 * CSS Modules scope animation names to their file, so `animation: spin` resolves only to a
 * `@keyframes spin` in the same module. A module without one renders a spinner that never
 * turns, with no build error or console warning.
 */
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')

const NOT_A_NAME = new Set([
  'infinite', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end',
  'normal', 'reverse', 'alternate', 'alternate-reverse', 'none', 'forwards', 'backwards', 'both',
  'running', 'paused', 'initial', 'inherit', 'unset',
])

function cssModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return cssModules(p)
    return e.name.endsWith('.module.css') ? [p] : []
  })
}

function undefinedAnimations(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const defined = new Set([...text.matchAll(/@keyframes\s+([-\w]+)/g)].map((m) => m[1]))
  // Functions go first: the commas inside cubic-bezier() and var() do not separate animations.
  const used = [...text.matchAll(/animation(?:-name)?\s*:\s*([^;}]+)/g)].flatMap((m) =>
    m[1]
      .replace(/[\w-]+\([^)]*\)/g, ' ')
      .split(/[\s,]+/)
      .filter((t) => t && !NOT_A_NAME.has(t) && !/^-?[\d.]+m?s?$/.test(t)),
  )
  return [...new Set(used.filter((n) => !defined.has(n)))]
}

describe('CSS module animations', () => {
  test('the parser finds a name with no local keyframes, and ignores timings and keywords', () => {
    expect(undefinedAnimations('.a { animation: spin 1s linear infinite; }')).toEqual(['spin'])
    expect(undefinedAnimations('.a { animation: 1s ease-in spin; } @keyframes spin { to {} }')).toEqual([])
    expect(undefinedAnimations('.a { animation: fade 1s, cubic-bezier(0, 0, 1, 1) 2s slide; } @keyframes fade {}')).toEqual(['slide'])
    expect(undefinedAnimations('/* animation: ghost 1s; */ .a { animation-name: none; }')).toEqual([])
  })

  test('every animation a module uses is defined in that module', () => {
    const missing = cssModules(SRC).flatMap((file) =>
      undefinedAnimations(readFileSync(file, 'utf8')).map((name) => `${path.relative(SRC, file)}: ${name}`),
    )
    expect(missing).toEqual([])
  })
})
