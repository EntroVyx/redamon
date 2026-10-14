import { ExternalLink } from 'lucide-react'
import { safeExternalUrl } from '@/lib/plugins/externalLink'
import styles from './page.module.css'

/**
 * /plugins/external-link?url=...: where every link in plugin text lands. It names the whole
 * address before anything leaves RedAmon. `external-link` is a reserved plugin id, so no
 * plugin's nav page can take this path.
 */
export default async function ExternalLinkPage({
  searchParams,
}: {
  searchParams: Promise<{ url?: string | string[] }>
}) {
  const { url: raw } = await searchParams
  const url = typeof raw === 'string' ? safeExternalUrl(raw) : null

  return (
    <main className={styles.page}>
      <div className={styles.card}>
        <h1 className={styles.title}>Leaving RedAmon</h1>
        {url ? (
          <>
            <p className={styles.text}>A plugin&apos;s text links to this address. Check it before you open it.</p>
            <code className={styles.url} data-testid="external-url">
              {url}
            </code>
            <p className={styles.host}>
              Host: <strong>{new URL(url).host}</strong>
            </p>
            <a className="primaryButton" href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden /> Open
            </a>
          </>
        ) : (
          <p className={styles.text}>
            This link cannot be opened: only http and https addresses, without a user name or password, are allowed.
          </p>
        )}
      </div>
    </main>
  )
}
