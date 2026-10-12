/*
 * Adapted from ZCode code-block.tsx (Apache-2.0), itself derived from
 * vercel/ai-elements. Copyright 2023 Vercel, Inc.
 * Source ranges and web highlighter adapter: CONVERSATION-PROVENANCE.md.
 */
import { code as codePlugin, type HighlightResult } from '@streamdown/code'
import { CheckIcon, CopyIcon, MaximizeIcon, WrapTextIcon } from 'lucide-react'
import {
  type CSSProperties,
  type HTMLAttributes,
  type RefObject,
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { BundledLanguage } from 'shiki'

import { cn } from '@/features/codex/vendor/zcode/utils'

import { Button } from '../button'
import { CodePreview } from './code-preview'
import { resolveMermaidAutoRenderDecision } from './mermaid-render-budget'

const MermaidBlock = lazy(() =>
  import('./mermaid-block').then((module) => ({ default: module.MermaidBlock }))
)

interface CodeBlockContextType {
  code: string
  toggleWrapLongLines: () => void
  wrapLongLines: boolean
  openPreview: () => void
  previewButton: RefObject<HTMLButtonElement | null>
}
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: '',
  toggleWrapLongLines: () => {},
  wrapLongLines: false,
  openPreview: () => {},
  previewButton: { current: null },
})

export function CodeBlockContainer({
  className,
  language,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) {
  return (
    <div
      className={cn(
        'zcode-code-block group relative w-full min-w-0 max-w-full overflow-hidden rounded-2xl text-foreground',
        className
      )}
      data-language={language}
      {...props}
    />
  )
}
export function CodeBlockHeader(props: { language: string }) {
  const { t } = useTranslation()
  const {
    code,
    toggleWrapLongLines,
    wrapLongLines,
    openPreview,
    previewButton,
  } = useContext(CodeBlockContext)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copy = useCallback(async () => {
    setCopied(false)
    setCopyFailed(false)
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setCopyFailed(false)
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyFailed(true)
    }
  }, [code])
  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    },
    []
  )
  return (
    <div className='zcode-code-header text-muted-foreground flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-1.5 text-xs'>
      <div className='flex min-w-0 items-center'>
        <span className='truncate font-sans font-medium lowercase'>
          {props.language || 'text'}
        </span>
      </div>
      <div className='-mr-1 flex shrink-0 items-center gap-1'>
        <Button
          ref={previewButton}
          aria-label={t('Open fullscreen preview')}
          title={t('Open fullscreen preview')}
          onClick={openPreview}
          size='icon-md'
          variant='ghost'
        >
          <MaximizeIcon className='size-3.5' aria-hidden />
        </Button>
        <Button
          aria-label={t('Wrap code lines')}
          title={t('Wrap code lines')}
          aria-pressed={wrapLongLines}
          className={cn(
            'shrink-0 rounded-md focus-visible:ring-2 focus-visible:ring-ring',
            wrapLongLines && 'bg-muted'
          )}
          onClick={toggleWrapLongLines}
          size='icon-md'
          type='button'
          variant='ghost'
        >
          <WrapTextIcon className='size-3.5' aria-hidden />
        </Button>
        <Button
          aria-label={copied ? t('Copied') : t('Copy code')}
          title={copied ? t('Copied') : t('Copy code')}
          className='focus-visible:ring-ring h-8 shrink-0 gap-1.5 rounded-md px-2 text-xs font-medium focus-visible:ring-2'
          onClick={() => void copy()}
          size='default'
          type='button'
          variant='ghost'
        >
          {copied ? (
            <CheckIcon className='size-3.5' aria-hidden />
          ) : (
            <CopyIcon className='size-3.5' aria-hidden />
          )}
          <span>{copied ? t('Copied') : t('Copy code')}</span>
        </Button>
      </div>
      <span
        role='status'
        className={copyFailed ? 'text-destructive w-full text-xs' : 'sr-only'}
      >
        {copied && t('Copied')}
        {copyFailed && t('Copy failed')}
      </span>
    </div>
  )
}
function HighlightedCode(props: {
  code: string
  language: string
  enabled: boolean
  wrapped: boolean
}) {
  const { t } = useTranslation()
  const [highlighted, setHighlighted] = useState<{
    source: string
    language: string
    result: HighlightResult
  } | null>(null)
  useEffect(() => {
    if (
      !props.enabled ||
      !codePlugin.supportsLanguage(props.language as BundledLanguage)
    ) {
      return
    }
    let active = true
    const accept = (result: HighlightResult) => {
      if (
        active &&
        result.tokens
          .map((line) => line.map((token) => token.content).join(''))
          .join('\n') === props.code
      ) {
        setHighlighted({ source: props.code, language: props.language, result })
      }
    }
    try {
      const ready = codePlugin.highlight(
        {
          code: props.code,
          language: props.language as BundledLanguage,
          themes: ['github-light', 'github-dark'],
        },
        accept
      )
      if (ready) accept(ready)
    } catch {
      /* Unknown grammars retain the original code. */
    }
    return () => {
      active = false
    }
  }, [props.code, props.language, props.enabled])
  const result =
    highlighted?.source === props.code &&
    highlighted.language === props.language &&
    props.enabled
      ? highlighted.result
      : null
  return (
    <pre
      className={cn(
        'zcode-highlight m-0 w-full min-w-0 max-w-full overflow-x-auto overscroll-x-contain bg-transparent px-4 py-4 font-mono text-[14px] leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        props.wrapped ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
      )}
      tabIndex={0}
      role='region'
      aria-label={t('Code')}
    >
      <code>
        {result
          ? result.tokens.map((line, lineIndex) => (
              <span
                className='code-line'
                key={`line-${line[0]?.offset ?? lineIndex}`}
              >
                {line.map((token, tokenIndex) => (
                  <span
                    key={`token-${token.offset ?? tokenIndex}`}
                    style={
                      {
                        color: token.color,
                        ...token.htmlStyle,
                      } as CSSProperties
                    }
                  >
                    {token.content}
                  </span>
                ))}
                {lineIndex < result.tokens.length - 1 ? '\n' : ''}
              </span>
            ))
          : props.code}
      </code>
    </pre>
  )
}
export function CodeBlock(props: {
  code: string
  language: string
  enableSyntaxHighlighting: boolean
  theme: 'light' | 'dark'
}) {
  const { t } = useTranslation()
  const [isWrapped, setIsWrapped] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewButton = useRef<HTMLButtonElement>(null)
  const [preview, setPreview] = useState<{
    code: string
    theme: string
    svg: string | null
  } | null>(null)
  const updatePreview = useCallback(
    (svg: string | null) =>
      setPreview({ code: props.code, theme: props.theme, svg }),
    [props.code, props.theme]
  )
  const openPreview = useCallback(() => setPreviewOpen(true), [])
  const toggleWrapLongLines = useCallback(
    () => setIsWrapped((value) => !value),
    []
  )
  const context = useMemo(
    () => ({
      code: props.code,
      toggleWrapLongLines,
      wrapLongLines: isWrapped,
      openPreview,
      previewButton,
    }),
    [props.code, isWrapped, toggleWrapLongLines, openPreview]
  )
  const diagram =
    ['mermaid', 'mmd'].includes(props.language.toLowerCase()) &&
    props.enableSyntaxHighlighting &&
    resolveMermaidAutoRenderDecision(props.code).shouldRender
  return (
    <CodeBlockContext.Provider value={context}>
      <CodeBlockContainer className='my-4' language={props.language}>
        <CodeBlockHeader language={props.language} />
        <div className={cn('min-w-0 max-w-full', diagram && 'p-4')}>
          {diagram ? (
            <Suspense
              fallback={
                <HighlightedCode
                  code={props.code}
                  language={props.language}
                  enabled={false}
                  wrapped={isWrapped}
                />
              }
            >
              <MermaidBlock
                code={props.code}
                theme={props.theme}
                onOpenPreview={openPreview}
                onPreviewSvgChange={updatePreview}
              />
            </Suspense>
          ) : (
            <HighlightedCode
              code={props.code}
              language={props.language}
              enabled={props.enableSyntaxHighlighting}
              wrapped={isWrapped}
            />
          )}
        </div>
      </CodeBlockContainer>
      <CodePreview
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        returnFocus={previewButton}
        language={props.language}
        svg={
          diagram &&
          preview?.code === props.code &&
          preview.theme === props.theme
            ? preview.svg
            : null
        }
        controls={
          <Button
            variant='ghost'
            size='icon-md'
            aria-label={t('Wrap code lines')}
            aria-pressed={isWrapped}
            onClick={toggleWrapLongLines}
          >
            <WrapTextIcon aria-hidden />
          </Button>
        }
      >
        <HighlightedCode
          code={props.code}
          language={props.language}
          enabled={props.enableSyntaxHighlighting}
          wrapped={isWrapped}
        />
      </CodePreview>
    </CodeBlockContext.Provider>
  )
}
