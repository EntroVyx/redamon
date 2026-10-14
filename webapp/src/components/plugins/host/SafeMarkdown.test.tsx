/**
 * SafeMarkdown draws plugin-supplied markdown (summaries, changelogs, screens). Raw HTML is
 * skipped, images and frames are dropped, and every link goes through the
 * /plugins/external-link confirmation page; anything that is not an absolute http(s) URL is
 * plain text (design §6 screen host; R-05/R-06).
 */
import { describe, test, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { SafeMarkdown } from './SafeMarkdown'

afterEach(() => cleanup())

const draw = (md: string) => render(<SafeMarkdown>{md}</SafeMarkdown>).container

describe('SafeMarkdown', () => {
  test('ordinary markdown renders', () => {
    const c = draw('**bold** and a list:\n\n- one\n- two')
    expect(c.querySelector('strong')?.textContent).toBe('bold')
    expect(c.querySelectorAll('li')).toHaveLength(2)
  })

  test('a <script> tag in the text is neither an element nor run', () => {
    const c = draw('before <script>window.__pwned = 1</script> after')
    expect(c.querySelector('script')).toBeNull()
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined()
    expect(c.textContent).toContain('before')
  })

  test('an <img onerror> tag is not an element', () => {
    const c = draw('x <img src="nope" onerror="window.__pwned = 1"> y')
    expect(c.querySelector('img')).toBeNull()
    expect(c.innerHTML).not.toContain('onerror')
  })

  test('raw inline HTML such as <b> is skipped, not interpreted', () => {
    const c = draw('a <b>not bold</b> b')
    expect(c.querySelector('b')).toBeNull()
  })

  test('a markdown image is not rendered', () => {
    const c = draw('![tracker](https://example.com/pixel.png)')
    expect(c.querySelector('img')).toBeNull()
  })

  test('an iframe is not rendered', () => {
    const c = draw('<iframe src="https://example.com"></iframe>')
    expect(c.querySelector('iframe')).toBeNull()
  })

  test('an https link goes through the confirmation page, in a new tab', () => {
    const c = draw('[the docs](https://example.com/page?a=1)')
    const a = c.querySelector('a')!
    expect(a.getAttribute('href')).toBe(`/plugins/external-link?url=${encodeURIComponent('https://example.com/page?a=1')}`)
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.textContent).toBe('the docs')
  })

  test('a javascript: link is refused: its text stays, with no link', () => {
    const c = draw('[click me](javascript:alert(1))')
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toContain('click me')
  })

  test('relative, data: and mailto: links are plain text', () => {
    const c = draw('[a](/api/projects) [b](data:text/html,hi) [c](mailto:x@example.com)')
    expect(c.querySelector('a')).toBeNull()
    expect(c.textContent).toContain('a')
  })

  test('a bare URL autolinked by GFM also goes through the confirmation page', () => {
    const c = draw('see https://example.org/x')
    expect(c.querySelector('a')?.getAttribute('href')).toBe(
      `/plugins/external-link?url=${encodeURIComponent('https://example.org/x')}`,
    )
  })
})
