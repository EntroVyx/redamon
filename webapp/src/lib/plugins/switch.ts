import { NextResponse } from 'next/server'

/** Default OFF: plugin code is third-party code; the platform is switched on deliberately. */
export function pluginsEnabled(): boolean {
  const v = (process.env.PLUGINS_ENABLED || '').trim().toLowerCase()
  return v === 'true' || v === '1'
}

/**
 * It names the switch because a bare 404 reads as a mistyped URL and sends an
 * operator after paths instead of the flag (the inbound MCP server learned this,
 * see MCP_DISABLED_MESSAGE). `./redamon.sh up` because a plain restart keeps the
 * container's old environment.
 */
export const PLUGINS_DISABLED_MESSAGE =
  'The plugin platform is disabled on this RedAmon deployment. An operator enables it with ' +
  'PLUGINS_ENABLED=true in .env, then runs ./redamon.sh up to recreate the webapp container.'

export function pluginsDisabledResponse(): NextResponse {
  return NextResponse.json(
    { error: PLUGINS_DISABLED_MESSAGE, code: 'plugins_disabled' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  )
}
