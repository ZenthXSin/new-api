/*
 * Adapted from ZCode, Copyright ZCode contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Upstream: zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e
 * Original: packages/ui/src/components/ui/lightweight-diff-preview.tsx
 * Changes: New API imports and types; accept source line numbers; truncation
 * notices are rendered by the New API request adapter.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { getPatchPreviewLineContent } from './patch-lines'

export type LightweightDiffLineKind = 'added' | 'removed' | 'context'

export interface LightweightDiffLineParts {
  content: string
  kind: LightweightDiffLineKind
  marker: string
  raw: string
}

type LightweightDiffLineStyles = {
  gutterStyle?: CSSProperties
  lineNumberClassName: string
  rowStyle?: CSSProperties
}

export interface LightweightDiffPreviewProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'children'
> {
  codePreviewSettings: {
    fontSizePx: number
    showLineNumbers: boolean
    wrapLongLines: boolean
  }
  lineNumbers?: readonly (string | number)[]
  lines: readonly string[]
  renderLineContent?: (
    line: LightweightDiffLineParts,
    index: number
  ) => ReactNode
}

function getLightweightDiffLineParts(line: string): LightweightDiffLineParts {
  if (line.startsWith('+')) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: 'added',
      marker: '+',
      raw: line,
    }
  }

  if (line.startsWith('-')) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: 'removed',
      marker: '-',
      raw: line,
    }
  }

  if (line.startsWith(' ')) {
    return {
      content: getPatchPreviewLineContent(line),
      kind: 'context',
      marker: ' ',
      raw: line,
    }
  }

  return {
    content: getPatchPreviewLineContent(line),
    kind: 'context',
    marker: '',
    raw: line,
  }
}

function getLightweightDiffLineStyles(
  kind: LightweightDiffLineKind
): LightweightDiffLineStyles {
  if (kind === 'added') {
    return {
      lineNumberClassName: 'text-diff-added',
      rowStyle: {
        backgroundColor:
          'color-mix(in srgb, var(--zcode-diff-added) 14%, transparent)',
        boxShadow: 'inset 3px 0 0 var(--zcode-diff-added)',
      },
      gutterStyle: {
        backgroundColor:
          'color-mix(in srgb, var(--zcode-diff-added) 18%, var(--background))',
        boxShadow: 'inset 3px 0 0 var(--zcode-diff-added)',
        color: 'var(--zcode-diff-added)',
      },
    }
  }

  if (kind === 'removed') {
    return {
      lineNumberClassName: 'text-diff-removed',
      rowStyle: {
        backgroundColor:
          'color-mix(in srgb, var(--zcode-diff-removed) 14%, transparent)',
        boxShadow: 'inset 3px 0 0 var(--zcode-diff-removed)',
      },
      gutterStyle: {
        backgroundColor:
          'color-mix(in srgb, var(--zcode-diff-removed) 18%, var(--background))',
        boxShadow: 'inset 3px 0 0 var(--zcode-diff-removed)',
        color: 'var(--zcode-diff-removed)',
      },
    }
  }

  return {
    lineNumberClassName: 'text-foreground-subtlest',
    gutterStyle: {
      backgroundColor: 'var(--background)',
    },
  }
}

export function LightweightDiffPreview({
  className,
  codePreviewSettings,
  lines,
  renderLineContent,
  lineNumbers,
  ...props
}: LightweightDiffPreviewProps) {
  return (
    <div
      className={cn('w-full min-w-0 overflow-auto bg-background', className)}
      data-lightweight-diff-preview
      {...props}
    >
      <div
        className={cn(
          'min-w-full font-mono leading-relaxed text-foreground',
          !codePreviewSettings.wrapLongLines && 'w-max'
        )}
        data-lightweight-diff-scroll-content
        style={{ fontSize: codePreviewSettings.fontSizePx }}
      >
        {lines.map((line, index) => {
          const lineParts = getLightweightDiffLineParts(line)
          const lineStyles = getLightweightDiffLineStyles(lineParts.kind)

          return (
            // A patch is an immutable ordered snapshot; identical source lines are
            // valid and have no per-row state. Keep the upstream positional keys.
            <div
              className='flex w-full min-w-full'
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              style={lineStyles.rowStyle}
            >
              {/* 不换行时由内层滚动面统一计算 max-content 宽度。
              如果每行各自 w-max，横向滚动到右侧时短行背景会提前结束，产生黑色断层。 */}
              {codePreviewSettings.showLineNumbers ? (
                <span
                  aria-hidden='true'
                  className={cn(
                    'sticky left-0 z-[1] w-12 shrink-0 select-none border-r border-border px-2 text-right tabular-nums',
                    lineStyles.lineNumberClassName
                  )}
                  style={lineStyles.gutterStyle}
                >
                  {lineNumbers?.[index] ?? index + 1}
                </span>
              ) : null}
              <code
                className={cn(
                  'block flex-1 px-3',
                  codePreviewSettings.wrapLongLines
                    ? 'whitespace-pre-wrap break-words'
                    : 'whitespace-pre'
                )}
              >
                {/* 轻量 diff 只用行背景、状态条和行号颜色表达增删，和富 DiffViewer 保持一致；
                不能把 unified diff 的 `+/-/空格` 协议 marker 当成代码内容显示出来。 */}
                {renderLineContent?.(lineParts, index) ??
                  (lineParts.content || ' ')}
              </code>
            </div>
          )
        })}
      </div>
    </div>
  )
}
