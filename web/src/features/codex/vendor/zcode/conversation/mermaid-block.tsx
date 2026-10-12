/* Adapted from ZCode (Apache-2.0). See CONVERSATION-PROVENANCE.md. */

import { createMermaidPlugin, type MermaidConfig } from '@streamdown/mermaid'
import DOMPurify from 'dompurify'
import { ChevronDownIcon, ChevronUpIcon, Loader2Icon } from 'lucide-react'
import { type HTMLAttributes, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { Button } from '../button'

type Theme = 'light' | 'dark' | 'system'
function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'dark' ||
    (theme === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
    ? 'dark'
    : 'light'
}

type MermaidRenderState =
  | {
      status: 'loading'
    }
  | {
      status: 'ready'
      svg: string
    }
  | {
      status: 'plaintext'
    }

export interface MermaidBlockProps extends HTMLAttributes<HTMLDivElement> {
  code: string
  /**
   * 应用主题（store 耦合剥离）：由调用方从上层状态传入。
   * 默认 "system" 跟随操作系统，供旧调用点/待删代码兜底。
   */
  theme?: Theme
  onOpenPreview?: () => void
  onPreviewSvgChange?: (svg: string | null) => void
}

const mermaidPlugin = createMermaidPlugin()
let mermaidRenderQueue = Promise.resolve()

// Serialize Mermaid rendering because its configuration is shared across diagrams.
function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const run = mermaidRenderQueue.then(task, task)
  mermaidRenderQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function hashMermaidCode(code: string): string {
  let hash = 2166136261
  for (let index = 0; index < code.length; index += 1) {
    hash ^= code.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return (hash >>> 0).toString(36)
}

function normalizeCssColorForMermaid(raw: string, fallback: string): string {
  return /^(#[\da-f]{3,8}|rgba?\()/i.test(raw.trim()) ? raw : fallback
}

function resolveCssColor(variableName: string, fallback: string): string {
  if (typeof document === 'undefined' || !document.body) {
    return fallback
  }

  const probe = document.createElement('span')
  probe.style.color = `var(${variableName})`
  probe.style.pointerEvents = 'none'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.appendChild(probe)
  const color = getComputedStyle(probe).color
  probe.remove()

  return normalizeCssColorForMermaid(color, fallback)
}

function createMermaidConfig(resolvedTheme: 'light' | 'dark'): MermaidConfig {
  const background = resolveCssColor(
    '--color-card',
    resolvedTheme === 'dark' ? '#18181b' : '#ffffff'
  )
  const surface = resolveCssColor(
    '--color-surface',
    resolvedTheme === 'dark' ? '#27272a' : '#f4f4f5'
  )
  const accent = resolveCssColor(
    '--color-accent',
    resolvedTheme === 'dark' ? '#1f2937' : '#f0f9ff'
  )
  const text = resolveCssColor(
    '--color-foreground',
    resolvedTheme === 'dark' ? '#f4f4f5' : '#27272a'
  )
  const subtleText = resolveCssColor(
    '--color-foreground-subtle',
    resolvedTheme === 'dark' ? '#a1a1aa' : '#52525b'
  )
  const border = resolveCssColor(
    '--color-border',
    resolvedTheme === 'dark' ? '#3f3f46' : '#d4d4d8'
  )

  return {
    fontFamily: 'ui-sans-serif, system-ui, sans-serif',
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: 'base',
    themeVariables: {
      actorBkg: background,
      actorBorder: border,
      actorTextColor: text,
      background,
      lineColor: subtleText,
      mainBkg: background,
      nodeBorder: border,
      noteBkgColor: accent,
      noteTextColor: text,
      primaryBorderColor: border,
      primaryColor: surface,
      primaryTextColor: text,
      secondaryBorderColor: border,
      secondaryColor: accent,
      secondaryTextColor: text,
      signalColor: subtleText,
      signalTextColor: text,
      tertiaryBorderColor: border,
      tertiaryColor: background,
      tertiaryTextColor: text,
      textColor: text,
    },
  }
}

function resolveBrowserTheme(theme: Theme): 'light' | 'dark' {
  if (typeof window === 'undefined') {
    return theme === 'dark' ? 'dark' : 'light'
  }

  return resolveTheme(theme)
}

function useSystemThemeRevision(theme: Theme): number {
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (theme !== 'system' || typeof window === 'undefined') {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => setRevision((current) => current + 1)

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }

    mediaQuery.addListener(handleChange)
    return () => mediaQuery.removeListener(handleChange)
  }, [theme])

  return revision
}

export function MermaidBlock({
  code,
  className,
  theme = 'system',
  onOpenPreview,
  onPreviewSvgChange,
  ...props
}: MermaidBlockProps) {
  const { t } = useTranslation()
  const systemThemeRevision = useSystemThemeRevision(theme)
  const renderIdPrefix = useId().replaceAll(/[^a-zA-Z0-9_-]/g, '')
  const trimmedCode = code.trim()
  const resolvedTheme = resolveBrowserTheme(theme)
  const themeKey = `${theme}:${resolvedTheme}:${systemThemeRevision}`
  const mermaidConfig = useMemo(
    () => createMermaidConfig(resolvedTheme),
    [resolvedTheme]
  )
  const renderKey = useMemo(
    () => `${themeKey}:${hashMermaidCode(trimmedCode)}`,
    [themeKey, trimmedCode]
  )
  const [renderState, setRenderState] = useState<MermaidRenderState>({
    status: 'loading',
  })
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false

    if (!trimmedCode) {
      setRenderState({
        status: 'plaintext',
      })
      onPreviewSvgChange?.(null)
      return
    }

    setRenderState({ status: 'loading' })
    onPreviewSvgChange?.(null)
    const renderId = `zcode-mermaid-${renderIdPrefix}-${hashMermaidCode(renderKey)}`

    void enqueueMermaidRender(async () => {
      const renderer = mermaidPlugin.getMermaid(mermaidConfig)
      return renderer.render(renderId, trimmedCode)
    })
      .then(({ svg }) => {
        if (!cancelled) {
          const cleanSvg = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            FORBID_TAGS: ['foreignObject'],
          })
          setRenderState({
            status: 'ready',
            svg: cleanSvg,
          })
          onPreviewSvgChange?.(cleanSvg)
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Mermaid 解析失败常见于模型流式输出未完成或用户粘贴了非标准语法。
          // 退回纯文本能保留内容可读，避免用错误面板打断聊天阅读。
          setRenderState({ status: 'plaintext' })
          onPreviewSvgChange?.(null)
        }
      })

    return () => {
      cancelled = true
      onPreviewSvgChange?.(null)
    }
  }, [
    mermaidConfig,
    onPreviewSvgChange,
    renderIdPrefix,
    renderKey,
    trimmedCode,
  ])

  return (
    <div
      className={cn(
        'group/mermaid relative min-h-32 w-full bg-card',
        className
      )}
      data-mermaid-block=''
      {...props}
    >
      <div
        className={cn(
          'text-foreground overflow-auto p-3',
          !expanded && 'max-h-[420px]'
        )}
      >
        {renderState.status === 'loading' ? (
          <div className='text-foreground-subtle text-ui-base flex min-h-28 items-center justify-center gap-2'>
            <Loader2Icon className='size-4 animate-spin' />
            <span>{t('Rendering diagram…')}</span>
          </div>
        ) : null}
        {renderState.status === 'plaintext' ? (
          <pre className='text-foreground text-ui-base m-0 min-h-28 min-w-max bg-transparent font-mono leading-relaxed'>
            {code}
          </pre>
        ) : null}
        {renderState.status === 'ready' ? (
          <div
            aria-label={t('Mermaid diagram')}
            className='flex min-h-28 min-w-max items-center justify-center [&_svg]:h-auto [&_svg]:max-w-none'
            dangerouslySetInnerHTML={{ __html: renderState.svg }}
            onDoubleClick={onOpenPreview}
            role='img'
          />
        ) : null}
      </div>
      {renderState.status === 'ready' && (
        <div className='flex justify-center pt-1'>
          <Button
            variant='ghost'
            size='sm'
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? (
              <ChevronUpIcon aria-hidden />
            ) : (
              <ChevronDownIcon aria-hidden />
            )}
            {expanded ? t('Collapse diagram') : t('Expand diagram')}
          </Button>
        </div>
      )}
    </div>
  )
}
