'use client'

import { usePluginsStatus } from '@/hooks/usePluginsStatus'

const WHY: Record<string, string> = {
  runner_not_configured: 'The runner key is not configured.',
  runner_unavailable: 'The plugin runner is not reachable.',
}

/** Says when plugin actions cannot run; approved skill versions are data and keep applying (D-21). */
export function RunnerStatusBanner() {
  const { data } = usePluginsStatus()
  const runner = data?.runner
  if (!runner) return null
  if (runner.reachable && runner.state !== 'out_of_date') return null
  const reason = runner.reachable
    ? 'The plugin runner is out of date for this RedAmon: rebuild it with ./redamon.sh up.'
    : (WHY[runner.error ?? ''] ?? `The plugin runner answered ${runner.error}.`)
  return (
    <div className="alert alertWarning" role="alert" data-testid="runner-banner">
      <div className="alertContent">
        <div className="alertTitle">Plugin actions are unavailable; approved skill versions keep applying.</div>
        <div className="alertMessage">{reason}</div>
      </div>
    </div>
  )
}
