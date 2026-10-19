'use client'

import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import { useTheme } from '@/hooks/useTheme'
import { getChartChrome, getTooltipStyle, getTooltipItemStyle, getTooltipLabelStyle, getCursorStyle } from '../utils/chartTheme'
import { ChartCard } from './ChartCard'
import { declaredNote } from '../utils/declared'

interface ParameterAnalysisBarProps {
  data: { position: string; total: number; injectable: number; declared?: number }[] | undefined
  isLoading: boolean
}

export function ParameterAnalysisBar({ data, isLoading }: ParameterAnalysisBarProps) {
  const { theme } = useTheme()
  const chrome = useMemo(() => getChartChrome(), [theme])
  const tooltipStyle = useMemo(() => getTooltipStyle(), [theme])
  const tooltipItemStyle = useMemo(() => getTooltipItemStyle(), [theme])
  const tooltipLabelStyle = useMemo(() => getTooltipLabelStyle(), [theme])
  const cursorStyle = useMemo(() => getCursorStyle(), [theme])

  const observed = (data || []).filter(d => d.total > 0)
  const totalParams = observed.reduce((s, d) => s + d.total, 0)
  const totalInjectable = observed.reduce((s, d) => s + d.injectable, 0)
  const declared = data?.reduce((s, d) => s + (d.declared ?? 0), 0) || 0

  return (
    <ChartCard
      title="Parameters by Position"
      subtitle={`${totalInjectable} injectable of ${totalParams} total${declaredNote(declared)}`}
      isLoading={isLoading}
      isEmpty={!observed.length}
    >
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={observed} margin={{ left: 8, right: 8, top: 8, bottom: 8 }}>
          <XAxis
            dataKey="position"
            tick={{ fontSize: 11, fill: chrome.axisColor }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis tick={{ fontSize: 11, fill: chrome.axisColor }} axisLine={false} tickLine={false} />
          <Tooltip cursor={cursorStyle} contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
          <Legend formatter={(value: string) => <span style={{ fontSize: 11 }}>{value}</span>} />
          <Bar dataKey="total" fill="#3b82f6" name="Total" radius={[4, 4, 0, 0]} maxBarSize={28} />
          <Bar dataKey="injectable" fill="#e53935" name="Injectable" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
