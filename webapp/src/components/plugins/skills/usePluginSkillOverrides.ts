'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ProjectSkillsRowContribution } from '@/lib/plugins/contributions'
import type { SkillSummary, SummaryModel } from '@/lib/plugins/summaryModel'

export interface ProjectSkillRowAction extends ProjectSkillsRowContribution {
  pluginId: string
  pluginDisplayName: string
}

interface Loaded {
  projectId: string
  bySkill: Map<string, SkillSummary>
  rowActions: ProjectSkillRowAction[]
}

const NONE = { bySkill: new Map<string, SkillSummary>(), rowActions: [] as ProjectSkillRowAction[] }

/**
 * The plugin facts the Agent Skills section needs for a saved project: the per-skill override
 * summary and the `project.skills.row` contributions. A failed or refused fetch of either
 * resolves to "nothing" here — the section must never break on a core page (RV-52). Null
 * projectId (create mode) fetches nothing.
 *
 * State is only ever set from a finished fetch, filed under its project: a reload keeps the
 * current rows on screen until the new answer replaces them (so a focused Versions button
 * stays put), while a project switch shows nothing from the old project. No effect sets state
 * synchronously.
 */
export function usePluginSkillOverrides(projectId: string | null | undefined) {
  const [reloads, setReloads] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!projectId) return
    let live = true
    Promise.all([
      fetch(`/api/plugins/overrides/summary?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/plugins/contributions', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([summary, contributions]) => {
        if (!live) return
        const bySkill = new Map<string, SkillSummary>()
        if (summary && Array.isArray((summary as SummaryModel).skills)) {
          for (const s of (summary as SummaryModel).skills) bySkill.set(s.skillId, s)
        }
        const rowActions: ProjectSkillRowAction[] = []
        if (Array.isArray(contributions)) {
          for (const c of contributions) {
            for (const row of c.projectSkillsRow ?? []) {
              rowActions.push({ ...row, pluginId: c.pluginId, pluginDisplayName: c.displayName })
            }
          }
        }
        setLoaded({ projectId, bySkill, rowActions })
      })
      .catch(() => {
        if (live) setLoaded({ projectId, ...NONE })
      })
    return () => {
      live = false
    }
  }, [projectId, reloads])

  const reload = useCallback(() => setReloads((n) => n + 1), [])

  const current = projectId && loaded && loaded.projectId === projectId ? loaded : null
  return {
    bySkill: current?.bySkill ?? NONE.bySkill,
    rowActions: current?.rowActions ?? NONE.rowActions,
    ready: !!current,
    reload,
  }
}
