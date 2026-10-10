import { notFound } from 'next/navigation'
import { pluginsEnabled } from '@/lib/plugins/switch'
import { PluginsPageClient } from './PluginsPageClient'

/** /plugins: the plugin catalog and lifecycle; not there at all while the platform is off (TD-02). */
export default function PluginsPage() {
  if (!pluginsEnabled()) notFound()
  return <PluginsPageClient />
}
