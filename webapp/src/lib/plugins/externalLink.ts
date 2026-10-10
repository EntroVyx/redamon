/**
 * Links in plugin-supplied text never navigate directly: they open
 * /plugins/external-link, which shows the whole address and opens it only on a click.
 * Only absolute http(s) URLs qualify. A URL with credentials is refused too:
 * `https://bank.example@other.example/` reads as one host and goes to another.
 */
export const EXTERNAL_LINK_PATH = '/plugins/external-link'
const URL_MAX = 2048

export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > URL_MAX) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  return url.href
}

export function externalLinkHref(raw: unknown): string | null {
  const url = safeExternalUrl(raw)
  return url ? `${EXTERNAL_LINK_PATH}?url=${encodeURIComponent(url)}` : null
}
