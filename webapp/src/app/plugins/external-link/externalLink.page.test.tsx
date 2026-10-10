/**
 * /plugins/external-link: the only way a plugin's text leaves RedAmon. It shows the whole
 * address and opens it only on a click, in a new tab without an opener; only http(s) URLs
 * without credentials are offered (design §6; R-05).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import ExternalLinkPage from './page'
import { externalLinkHref, safeExternalUrl } from '@/lib/plugins/externalLink'

const open = async (url?: string | string[]) =>
  render(await ExternalLinkPage({ searchParams: Promise.resolve(url === undefined ? {} : { url }) }))

beforeEach(() => vi.stubEnv('PLUGINS_ENABLED', 'true'))
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe('safeExternalUrl / externalLinkHref', () => {
  test('http and https pass, normalised', () => {
    expect(safeExternalUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeExternalUrl('http://example.org')).toBe('http://example.org/')
  })

  test('other schemes, credentials, relative and junk are refused', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      'mailto:x@example.com',
      'https://user:pw@example.com/',
      'https://example.com@example.org/',
      '/api/projects',
      '',
      'not a url',
      'x'.repeat(3000),
      undefined,
    ]) {
      expect(safeExternalUrl(bad), String(bad)).toBeNull()
    }
  })

  test('the confirmation href encodes the URL', () => {
    expect(externalLinkHref('https://example.com/?a=1&b=2')).toBe(
      `/plugins/external-link?url=${encodeURIComponent('https://example.com/?a=1&b=2')}`,
    )
    expect(externalLinkHref('javascript:alert(1)')).toBeNull()
  })
})

describe('the page', () => {
  test('shows the full address and an Open link in a new tab without an opener', async () => {
    await open('https://example.com/docs/page')
    expect(screen.getByTestId('external-url').textContent).toBe('https://example.com/docs/page')
    const link = screen.getByRole('link', { name: /open/i })
    expect(link.getAttribute('href')).toBe('https://example.com/docs/page')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  test('a javascript: URL gets no link, and says why', async () => {
    await open('javascript:alert(1)')
    expect(screen.queryByRole('link', { name: /open/i })).toBeNull()
    expect(screen.getByText(/only http and https/i)).toBeInTheDocument()
  })

  test('no url, or several, gets no link', async () => {
    await open()
    expect(screen.queryByRole('link', { name: /open/i })).toBeNull()
    cleanup()
    await open(['https://example.com', 'https://example.org'])
    expect(screen.queryAllByRole('link', { name: /open/i })).toHaveLength(0)
  })

  test('switch off: not found', async () => {
    vi.stubEnv('PLUGINS_ENABLED', 'false')
    await expect(open('https://example.com')).rejects.toThrow('NEXT_NOT_FOUND')
  })
})
