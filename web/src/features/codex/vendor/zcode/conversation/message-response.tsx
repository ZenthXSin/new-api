/*
 * Derived from ZCode MessageResponse (packages/ui/src/components/ai-elements/message.tsx),
 * commit 29628c9acdb81b703bbd4080c207a0e7ce5e276e, Apache-2.0.
 * AI Elements portions: Copyright 2023 Vercel, Inc.
 * Browser-only adaptation; source ranges: CONVERSATION-PROVENANCE.md.
 */
import { cjk } from '@streamdown/cjk'
import { code } from '@streamdown/code'
import { createMathPlugin } from '@streamdown/math'
import {
  type ComponentProps,
  type ReactNode,
  Component,
  isValidElement,
  memo,
  useContext,
  useMemo,
} from 'react'
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough'
import { defaultRemarkPlugins, Streamdown } from 'streamdown'
import type { Pluggable, PluggableList } from 'unified'

import { useTheme } from '@/context/theme-provider'
import { resolveWorkspaceFileLink } from '@/features/codex/lib/workspace-file-link'
import { WorkspaceFileLinkContext } from '@/features/codex/lib/workspace-file-link-context'
import { workspaceFileMarkdown } from '@/features/codex/lib/workspace-file-markdown'
import { cn } from '@/features/codex/vendor/zcode/utils'

import { CodeBlock } from './code-block'
import { MarkdownBlockquote } from './markdown-blockquote'
import {
  MarkdownListItem,
  MarkdownOrderedList,
  MarkdownUnorderedList,
} from './markdown-list'
import {
  MarkdownTable,
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableHead,
  MarkdownTableHeader,
  MarkdownTableRow,
} from './markdown-table'
import { normalizeMessageSingleDollarMath } from './normalize-markdown'

import './markdown.css'

const messageMathPlugin = createMathPlugin({ singleDollarTextMath: true })
function disableSingleTilde(plugin: Pluggable): Pluggable {
  if (!Array.isArray(plugin)) {
    return typeof plugin === 'function'
      ? [plugin, { singleTilde: false }]
      : plugin
  }
  const [attacher, existingOptions] = plugin
  return [
    attacher,
    {
      ...(typeof existingOptions === 'object' && existingOptions !== null
        ? existingOptions
        : {}),
      singleTilde: false,
    },
  ]
}
const messageCjkRemarkPluginsAfter = cjk.remarkPluginsAfter.map((plugin) => {
  const attacher = Array.isArray(plugin) ? plugin[0] : plugin
  return attacher === remarkCjkFriendlyGfmStrikethrough
    ? disableSingleTilde(plugin)
    : plugin
})
const messageCjkPlugin: typeof cjk = {
  ...cjk,
  remarkPlugins: [...cjk.remarkPluginsBefore, ...messageCjkRemarkPluginsAfter],
  remarkPluginsAfter: messageCjkRemarkPluginsAfter,
}
const streamdownPlugins = {
  cjk: messageCjkPlugin,
  code,
  math: messageMathPlugin,
}
const messageRemarkPlugins: PluggableList = Object.entries(
  defaultRemarkPlugins
).map(([name, plugin]) =>
  name === 'gfm' ? disableSingleTilde(plugin) : plugin
)
const messageMarkdownHeadingClassNames = {
  h1: 'mt-7 mb-4 text-2xl leading-snug font-semibold',
  h2: 'mt-6 mb-3 text-xl leading-snug font-semibold',
  h3: 'mt-6 mb-3 text-lg leading-snug font-semibold',
  h4: 'mt-5 mb-2 text-base leading-normal font-semibold',
  h5: 'mt-5 mb-2 text-base leading-normal font-semibold',
  h6: 'mt-5 mb-2 text-base leading-normal font-semibold',
}
function extractCodeText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children)
  }
  if (Array.isArray(children)) return children.map(extractCodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return extractCodeText(children.props.children)
  }
  return ''
}
function MessageMarkdownHeading({
  className,
  headingLevel,
  node: _node,
  ...props
}: ComponentProps<'h1'> & {
  node?: unknown
  headingLevel: keyof typeof messageMarkdownHeadingClassNames
}) {
  const Tag = headingLevel
  return (
    <Tag
      className={cn(messageMarkdownHeadingClassNames[headingLevel], className)}
      data-streamdown={`heading-${headingLevel.slice(1)}`}
      {...props}
    />
  )
}
function resolveMarkdownLink(
  href: string | undefined
): { href: string; external: boolean } | null {
  if (!href?.trim()) return null
  try {
    const url = new URL(href, 'https://markdown.local')
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
      return null
    }
    return { href, external: /^(https?:)?\/\//i.test(href.trim()) }
  } catch {
    return null
  }
}
function hashMarkdownCacheKey(markdown: string): string {
  let hash = 2166136261
  for (let index = 0; index < markdown.length; index++) {
    hash ^= markdown.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${markdown.length}:${hash >>> 0}`
}
class MessageResponseMarkdownBoundary extends Component<
  {
    children: ReactNode
    className: string
    fallbackText: string
    resetKey: string
  },
  { error: boolean }
> {
  state = { error: false }
  static getDerivedStateFromError() {
    return { error: true }
  }
  render() {
    if (this.state.error) {
      return (
        <div
          className={cn(
            this.props.className,
            'whitespace-pre-wrap break-words'
          )}
        >
          {this.props.fallbackText}
        </div>
      )
    }
    return this.props.children
  }
}
export const MessageResponse = memo(function MessageResponse(props: {
  children: string
  streaming?: boolean
  className?: string
}) {
  const { resolvedTheme } = useTheme()
  const project = useContext(WorkspaceFileLinkContext)
  const targetMarkdown = useMemo(
    () => normalizeMessageSingleDollarMath(props.children),
    [props.children]
  )
  const fileRemarkPlugins = useMemo<PluggableList>(
    () =>
      project
        ? [
            ...messageRemarkPlugins,
            [
              workspaceFileMarkdown,
              {
                workspaceId: project.workspaceId,
                remoteRoot: project.remoteRoot,
              },
            ],
          ]
        : messageRemarkPlugins,
    [project]
  )
  const renderStreaming = props.streaming ?? false
  const streamdownMode = renderStreaming ? 'streaming' : 'static'
  const responseClassName = cn(
    'zcode-markdown w-full min-w-0 max-w-full text-[16px] leading-[1.65] tracking-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
    props.className
  )
  const boundaryResetKey = renderStreaming
    ? 'streaming'
    : `static:${hashMarkdownCacheKey(targetMarkdown)}`
  const messageComponents = useMemo(
    () => ({
      a: ({ children, className, href, title }: ComponentProps<'a'>) => {
        const file = project
          ? resolveWorkspaceFileLink(
              href,
              project.workspaceId,
              project.remoteRoot
            )
          : null
        if (file?.type === 'unavailable') {
          return <span className={className}>{children}</span>
        }
        const link = resolveMarkdownLink(href)
        if (file?.type === 'file' && project) {
          const search = new URLSearchParams({
            workspace: project.workspaceId,
            file: file.path,
          })
          if (project.conversationId) {
            search.set('conversation', project.conversationId)
          }
          if (file.line) search.set('line', String(file.line))
          return (
            <a
              className={cn(
                'wrap-anywhere text-icon-blue underline decoration-current/40 underline-offset-2 hover:decoration-current',
                className
              )}
              href={`/codex?${search}`}
              title={title || file.path}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey
                ) {
                  return
                }
                event.preventDefault()
                project.open(file)
              }}
            >
              {children}
            </a>
          )
        }
        if (!link) return <span className={className}>{children}</span>
        return (
          <a
            className={cn(
              'wrap-anywhere text-icon-blue underline decoration-current/40 underline-offset-2 hover:decoration-current focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2',
              className
            )}
            href={link.href}
            title={title}
            target={link.external ? '_blank' : undefined}
            rel={link.external ? 'noopener noreferrer' : undefined}
          >
            {children}
          </a>
        )
      },
      img: ({ src, alt }: ComponentProps<'img'>) =>
        typeof src === 'string' && /^https?:\/\//i.test(src) ? (
          <img
            src={src}
            alt={alt || ''}
            loading='lazy'
            referrerPolicy='no-referrer'
            className='my-3 max-h-96 max-w-full rounded-lg object-contain'
          />
        ) : (
          <span>{alt}</span>
        ),
      h1: (value: ComponentProps<'h1'>) => (
        <MessageMarkdownHeading {...value} headingLevel='h1' />
      ),
      h2: (value: ComponentProps<'h2'>) => (
        <MessageMarkdownHeading {...value} headingLevel='h2' />
      ),
      h3: (value: ComponentProps<'h3'>) => (
        <MessageMarkdownHeading {...value} headingLevel='h3' />
      ),
      h4: (value: ComponentProps<'h4'>) => (
        <MessageMarkdownHeading {...value} headingLevel='h4' />
      ),
      h5: (value: ComponentProps<'h5'>) => (
        <MessageMarkdownHeading {...value} headingLevel='h5' />
      ),
      h6: (value: ComponentProps<'h6'>) => (
        <MessageMarkdownHeading {...value} headingLevel='h6' />
      ),
      strong: ({
        className,
        node: _node,
        ...rest
      }: ComponentProps<'strong'> & { node?: unknown }) => (
        <strong className={cn('font-semibold', className)} {...rest} />
      ),
      code: ({
        children,
        className,
        node: _node,
        ...rest
      }: ComponentProps<'code'> & {
        node?: unknown
        'data-block'?: unknown
      }) => {
        if (!('data-block' in rest)) {
          return (
            <code
              className={cn(
                'rounded-sm bg-markdown-inline-code/50 px-1 py-0.5 font-mono text-[0.875em]',
                className
              )}
              {...rest}
            >
              {children}
            </code>
          )
        }
        const codeText = extractCodeText(children).replace(/\n+$/, '')
        const language =
          className?.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? 'text'
        return (
          <CodeBlock
            code={codeText}
            language={language}
            enableSyntaxHighlighting={!renderStreaming}
            theme={resolvedTheme}
          />
        )
      },
      blockquote: MarkdownBlockquote,
      li: MarkdownListItem,
      ol: MarkdownOrderedList,
      table: MarkdownTable,
      tbody: MarkdownTableBody,
      td: MarkdownTableCell,
      th: MarkdownTableHead,
      thead: MarkdownTableHeader,
      tr: MarkdownTableRow,
      ul: MarkdownUnorderedList,
    }),
    [renderStreaming, resolvedTheme, project]
  )
  return (
    <MessageResponseMarkdownBoundary
      key={boundaryResetKey}
      className={responseClassName}
      fallbackText={targetMarkdown}
      resetKey={boundaryResetKey}
    >
      <div
        data-codex-markdown='true'
        data-streaming={renderStreaming ? 'true' : 'false'}
        className='max-w-full min-w-0'
      >
        <Streamdown
          key={resolvedTheme}
          className={responseClassName}
          mode={streamdownMode}
          components={messageComponents}
          parseIncompleteMarkdown={renderStreaming}
          linkSafety={{ enabled: false }}
          plugins={streamdownPlugins}
          controls={{ table: { fullscreen: false } }}
          remarkPlugins={fileRemarkPlugins}
          shikiTheme={['github-light', 'github-dark']}
          animated={false}
          isAnimating={false}
          skipHtml
        >
          {targetMarkdown}
        </Streamdown>
      </div>
    </MessageResponseMarkdownBoundary>
  )
})
