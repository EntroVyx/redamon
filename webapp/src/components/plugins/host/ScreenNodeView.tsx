'use client'

import type { ScreenNode } from '@/lib/plugins/schemas/screen'
import type { Params } from './hostContext'
import { BadgePrimitive } from './BadgePrimitive'
import { ButtonPrimitive } from './ButtonPrimitive'
import { EmptyStatePrimitive } from './EmptyStatePrimitive'
import { FormPrimitive } from './FormPrimitive'
import { ListPrimitive } from './ListPrimitive'
import { MarkdownPrimitive } from './MarkdownPrimitive'
import { PagePrimitive } from './PagePrimitive'
import { SelectPrimitive } from './SelectPrimitive'
import { TablePrimitive } from './TablePrimitive'
import { TextDiffPrimitive } from './TextDiffPrimitive'

/** One validated node, drawn by its primitive. `data` is what field bindings read. */
export function ScreenNodeView({ node, data }: { node: ScreenNode; data: Params }) {
  switch (node.type) {
    case 'page':
      return <PagePrimitive node={node} data={data} />
    case 'list':
      return <ListPrimitive node={node} />
    case 'table':
      return <TablePrimitive node={node} />
    case 'form':
      return <FormPrimitive node={node} />
    case 'select':
      return <SelectPrimitive node={node} />
    case 'button':
      return <ButtonPrimitive node={node} />
    case 'markdown':
      return <MarkdownPrimitive node={node} data={data} />
    case 'textDiff':
      return <TextDiffPrimitive node={node} data={data} />
    case 'badge':
      return <BadgePrimitive node={node} data={data} />
    case 'emptyState':
      return <EmptyStatePrimitive node={node} />
  }
}
