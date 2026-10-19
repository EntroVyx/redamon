'use client'

import { useMemo } from 'react'
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts'
import { useTheme } from '@/hooks/useTheme'
import { getTooltipStyle, getTooltipItemStyle, getTooltipLabelStyle } from '../utils/chartTheme'
import { ChartCard } from './ChartCard'
import { declaredNote } from '../utils/declared'

interface EndpointTypePieProps {
  data: { type: string; count: number; declared?: number }[] | undefined
  isLoading: boolean
}

const TYPE_COLORS: Record<string, string> = {
  Form: '#e53935',
  Parameterized: '#f97316',
  Static: '#71717a',
}

export function EndpointTypePie({ data, isLoading }: EndpointTypePieProps) {
  const { theme } = useTheme()
  const tooltipStyle = useMemo(() => getTooltipStyle(), [theme])
  const tooltipItemStyle = useMemo(() => getTooltipItemStyle(), [theme])
  const tooltipLabelStyle = useMemo(() => getTooltipLabelStyle(), [theme])

  const observed = (data || []).filter(d => d.count > 0)
  const total = observed.reduce((s, d) => s + d.count, 0)
  const declared = data?.reduce((s, d) => s + (d.declared ?? 0), 0) || 0

  return (
    <ChartCard title="Endpoint Types" subtitle={`${total} endpoints${declaredNote(declared)}`} isLoading={isLoading} isEmpty={!observed.length}>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={observed}
            dataKey="count"
            nameKey="type"
            cx="50%"
            cy="50%"
            outerRadius={70}
            paddingAngle={2}
            stroke="none"
          >
            {observed.map((entry) => (
              <Cell key={entry.type} fill={TYPE_COLORS[entry.type] || '#71717a'} />
            ))}
          </Pie>
          <Tooltip contentStyle={tooltipStyle} itemStyle={tooltipItemStyle} labelStyle={tooltipLabelStyle} />
          <Legend formatter={(value: string) => <span style={{ fontSize: 11 }}>{value}</span>} />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
