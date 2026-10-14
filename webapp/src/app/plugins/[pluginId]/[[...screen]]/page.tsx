import { notFound } from 'next/navigation'
import { resolveNavScreen } from '@/lib/plugins/navScreens'
import { PluginNavClient } from './PluginNavClient'

/**
 * /plugins/<pluginId>[/<screen...>]: a plugin's own page (design §6 `nav` point). Static
 * siblings such as /plugins/external-link take precedence, which is why those names are
 * reserved plugin ids. The strict CSP for these paths is set by the middleware.
 */
export const dynamic = 'force-dynamic'

export default async function PluginNavPage({
  params,
  searchParams,
}: {
  params: Promise<{ pluginId: string; screen?: string[] }>
  searchParams: Promise<{ k?: string | string[] }>
}) {
  const { pluginId, screen } = await params
  const nav = await resolveNavScreen(pluginId, screen)
  if (!nav) notFound()
  const { k } = await searchParams
  return <PluginNavClient nav={nav} handoffKey={typeof k === 'string' ? k : null} />
}
