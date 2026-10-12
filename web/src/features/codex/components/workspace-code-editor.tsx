/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
} from '@codemirror/commands'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import {
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language'
import { Compartment, EditorState, Transaction } from '@codemirror/state'
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

const codeHighlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier, tags.definitionKeyword],
    class: 'codex-code-keyword',
  },
  { tag: [tags.string, tags.regexp], class: 'codex-code-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'codex-code-number' },
  { tag: [tags.comment, tags.meta], class: 'codex-code-comment' },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
    class: 'codex-code-name',
  },
  {
    tag: [tags.typeName, tags.tagName, tags.attributeName],
    class: 'codex-code-type',
  },
])
const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '13px',
    fontWeight: '400',
  },
  '&.cm-focused': {
    outline: '2px solid var(--ring)',
    outlineOffset: '-2px',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.65rem',
    overscrollBehavior: 'contain',
    overflow: 'auto',
  },
  '.cm-content': {
    minWidth: 'max-content',
    padding: '18px 0 32px',
    caretColor: 'var(--foreground)',
  },
  '.cm-line': { padding: '0 24px 0 16px' },
  '.cm-gutters': {
    backgroundColor: 'var(--background)',
    color: 'var(--muted-foreground)',
    borderRight: 'none',
  },
  '.cm-gutterElement': { padding: '0 8px 0 16px', minWidth: '42px' },
  '.cm-activeLine': { backgroundColor: 'var(--muted)' },
  '.cm-activeLineGutter': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--muted)',
  },
  '.cm-selectionBackground': { backgroundColor: 'var(--zcode-selected)' },
  '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
})

export function WorkspaceCodeEditor(props: {
  path: string
  initialLine?: number
  value: string
  readOnly: boolean
  focusOnEdit?: boolean
  onChange: (value: string) => void
  onSave: () => void
}) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const permissions = useRef(new Compartment())
  const callbacks = useRef(props)
  callbacks.current = props
  const changingValue = useRef(false)
  const ariaLabel = t('File contents')
  useEffect(() => {
    if (!host.current) return
    const extension = props.path.split('.').at(-1)?.toLowerCase()
    let language = [] as ReturnType<typeof javascript> | []
    if (
      ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json'].includes(extension || '')
    ) {
      language = javascript({
        typescript: ['ts', 'tsx'].includes(extension || ''),
        jsx: ['jsx', 'tsx'].includes(extension || ''),
      })
    } else if (['html', 'htm', 'vue', 'svelte'].includes(extension || '')) {
      language = html()
    } else if (['css', 'scss'].includes(extension || '')) language = css()
    else if (['md', 'mdx', 'markdown'].includes(extension || '')) {
      language = markdown()
    }
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: callbacks.current.value,
        extensions: [
          language,
          syntaxHighlighting(codeHighlight),
          bracketMatching(),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          editorTheme,
          EditorState.tabSize.of(2),
          history(),
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel,
            'aria-multiline': 'true',
            tabindex: '0',
            spellcheck: 'false',
            'aria-description': t(
              'Press Escape, then Tab to leave the editor.'
            ),
          }),
          permissions.current.of([
            EditorState.readOnly.of(callbacks.current.readOnly),
            EditorView.editable.of(!callbacks.current.readOnly),
            EditorView.contentAttributes.of({
              'aria-readonly': String(callbacks.current.readOnly),
            }),
          ]),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: () => {
                callbacks.current.onSave()
                return true
              },
            },
            {
              key: 'Escape',
              run: (target) => {
                target.setTabFocusMode(2000)
                return false
              },
            },
            { key: 'Mod-Shift-z', run: redo, preventDefault: true },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !changingValue.current) {
              callbacks.current.onChange(update.state.doc.toString())
            }
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [props.path, ariaLabel, t])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      effects: permissions.current.reconfigure([
        EditorState.readOnly.of(props.readOnly),
        EditorView.editable.of(!props.readOnly),
        EditorView.contentAttributes.of({
          'aria-readonly': String(props.readOnly),
        }),
      ]),
    })
  }, [props.readOnly])
  useEffect(() => {
    if (props.focusOnEdit) view.current?.focus()
  }, [props.focusOnEdit])
  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === props.value) return
    changingValue.current = true
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: props.value },
      annotations: Transaction.addToHistory.of(false),
    })
    changingValue.current = false
  }, [props.value])
  useEffect(() => {
    const editor = view.current
    if (!editor || !props.initialLine) return
    const line = editor.state.doc.line(
      Math.min(props.initialLine, editor.state.doc.lines)
    )
    editor.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'center' }),
    })
  }, [props.initialLine, props.value])
  return (
    <div
      ref={host}
      className='[&_.codex-code-comment]:text-muted-foreground min-h-0 w-full min-w-0 flex-1 overflow-hidden [&_.cm-editor]:h-full [&_.cm-editor]:text-base! md:[&_.cm-editor]:text-[13px]! [&_.cm-scroller]:min-h-0 [&_.codex-code-keyword]:text-purple-700 dark:[&_.codex-code-keyword]:text-purple-300 [&_.codex-code-name]:text-blue-700 dark:[&_.codex-code-name]:text-blue-300 [&_.codex-code-number]:text-amber-700 dark:[&_.codex-code-number]:text-amber-300 [&_.codex-code-string]:text-emerald-700 dark:[&_.codex-code-string]:text-emerald-300 [&_.codex-code-type]:text-cyan-700 dark:[&_.codex-code-type]:text-cyan-300'
    />
  )
}
