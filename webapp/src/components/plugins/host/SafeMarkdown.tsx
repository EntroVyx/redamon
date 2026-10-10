'use client'

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { externalLinkHref } from '@/lib/plugins/externalLink'

/**
 * Markdown from a plugin. Raw HTML is skipped and images/frames dropped (an image is a
 * request the viewer did not choose); every link opens the confirmation page in a new tab,
 * and anything but an absolute http(s) URL stays plain text. These pages have no strict CSP
 * (the chat drawer, project settings), so this is the control there.
 */
const DISALLOWED = ['img', 'iframe', 'script', 'style']

const components: Components = {
  a: ({ href, children }) => {
    const to = externalLinkHref(href)
    if (!to) return <span>{children}</span>
    return (
      <a href={to} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  },
}

export function SafeMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml disallowedElements={DISALLOWED} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  )
}
