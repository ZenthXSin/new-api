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
import { useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PromptInput,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { Alert, AlertDescription } from '@/components/ui/alert'

import {
  ATTACHMENT_ACCEPT,
  IMAGE_ACCEPT,
} from '../../attachments/attachment-files'
import { AttachmentPreview } from '../../attachments/attachment-preview'
import { CameraDialog } from '../../attachments/camera-dialog'
import { useAttachmentSources } from '../../attachments/use-attachment-sources'
import { usePlaygroundAttachments } from '../../attachments/use-attachments'
import { getInputControlState } from '../../lib/input/input-control-utils'
import type {
  ModelOption,
  GroupOption,
  ParameterEnabled,
  PlaygroundConfig,
  PlaygroundAttachment,
} from '../../types'
import { PlaygroundInputControls } from './playground-input-controls'
import { PlaygroundInputTools } from './playground-input-tools'

interface PlaygroundInputProps {
  config: PlaygroundConfig
  onSubmit: (
    text: string,
    attachments?: PlaygroundAttachment[]
  ) => void | Promise<void>
  onStop?: () => void
  disabled?: boolean
  isGenerating?: boolean
  models: ModelOption[]
  modelValue: string
  onModelChange: (value: string) => void
  isModelLoading?: boolean
  groups: GroupOption[]
  groupValue: string
  onGroupChange: (value: string) => void
  hasMessages?: boolean
  onConfigChange: <K extends keyof PlaygroundConfig>(
    key: K,
    value: PlaygroundConfig[K]
  ) => void
  onClearMessages?: () => void | Promise<void>
  onParameterEnabledChange: (
    key: keyof ParameterEnabled,
    value: boolean
  ) => void
  parameterEnabled: ParameterEnabled
}

export function PlaygroundInput(props: PlaygroundInputProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submissionLock = useRef(false)
  const attachments = usePlaygroundAttachments()
  const sources = useAttachmentSources({
    disabled: Boolean(
      props.disabled || props.isGenerating || attachments.busy || submitting
    ),
    add: attachments.add,
    setError: attachments.setError,
  })
  const draftLocked = Boolean(
    props.disabled || props.isGenerating || submitting
  )
  const busy = attachments.busy || sources.capturingScreen || sources.cameraOpen
  const disabled = draftLocked || busy
  const controlState = getInputControlState({
    disabled,
    groups: props.groups,
    groupValue: props.groupValue,
    models: props.models,
    modelValue: props.modelValue,
    isModelLoading: props.isModelLoading,
    isGenerating: props.isGenerating,
    text,
    attachmentCount: attachments.attachments.length,
    hasStopHandler: Boolean(props.onStop),
  })
  const handleSubmit = async (message: PromptInputMessage) => {
    if (!controlState.canSubmit || submissionLock.current) return
    submissionLock.current = true
    setSubmitting(true)
    attachments.setError('')
    try {
      await props.onSubmit(message.text ?? '', attachments.attachments)
      setText('')
      attachments.clear()
    } catch {
      attachments.setError(
        t(
          'The message was not sent. Your draft is still here. Please try again.'
        )
      )
    } finally {
      submissionLock.current = false
      setSubmitting(false)
    }
  }
  const selectFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (!disabled) void attachments.add(files)
  }
  return (
    <div className='grid shrink-0 gap-3 px-1 md:pb-4'>
      <input
        ref={sources.fileInput}
        type='file'
        multiple
        accept={ATTACHMENT_ACCEPT}
        className='hidden'
        aria-label={t('Upload file')}
        onChange={selectFiles}
        disabled={disabled}
      />
      <input
        ref={sources.photoInput}
        type='file'
        multiple
        accept={IMAGE_ACCEPT}
        className='hidden'
        aria-label={t('Upload photo')}
        onChange={selectFiles}
        disabled={disabled}
      />
      <input
        ref={sources.mobileCameraInput}
        type='file'
        accept={IMAGE_ACCEPT}
        capture='environment'
        className='hidden'
        aria-label={t('Take photo')}
        onChange={selectFiles}
        disabled={draftLocked || attachments.busy || sources.capturingScreen}
      />
      <PromptInput
        className='relative'
        groupClassName='bg-background/95 dark:bg-background/80 border-border/70 shadow-[0_18px_60px_-32px_rgba(0,0,0,0.65)] ring-1 ring-foreground/5 rounded-xl overflow-hidden transition-all duration-200 focus-within:border-primary/45 focus-within:ring-primary/15 focus-within:shadow-[0_22px_70px_-34px_rgba(0,0,0,0.75)]'
        onSubmit={handleSubmit}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDropCapture={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.stopPropagation()
          if (!disabled) {
            void attachments.add([...event.dataTransfer.files])
          } else {
            attachments.setError(
              t(
                'Wait until the current operation finishes before adding attachments.'
              )
            )
          }
        }}
        onPasteCapture={(event) => {
          const files = [...event.clipboardData.files]
          if (!files.length) return
          event.preventDefault()
          event.stopPropagation()
          if (!disabled) void attachments.add(files)
          else {
            attachments.setError(
              t(
                'Wait until the current operation finishes before adding attachments.'
              )
            )
          }
        }}
      >
        {attachments.attachments.length > 0 && (
          <PromptInputHeader>
            <AttachmentPreview
              attachments={attachments.attachments}
              disabled={disabled}
              onRemove={attachments.remove}
            />
          </PromptInputHeader>
        )}
        <PromptInputTextarea
          autoComplete='off'
          autoCorrect='off'
          autoCapitalize='off'
          spellCheck={false}
          className='min-h-20 px-5 pt-4 pb-3 leading-7 md:min-h-24 md:text-base'
          disabled={draftLocked}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('Ask anything')}
          value={text}
        />
        <PromptInputFooter className='border-border/60 bg-muted/20 dark:bg-muted/10 border-t px-3 py-2.5 backdrop-blur'>
          <PlaygroundInputControls
            disabled={disabled}
            attachmentCount={attachments.attachments.length}
            groups={props.groups}
            groupValue={props.groupValue}
            isGenerating={props.isGenerating}
            isModelLoading={props.isModelLoading}
            models={props.models}
            modelValue={props.modelValue}
            onGroupChange={props.onGroupChange}
            onModelChange={props.onModelChange}
            onStop={props.onStop}
            text={text}
            tools={
              <PlaygroundInputTools
                config={props.config}
                disabled={disabled}
                hasMessages={props.hasMessages}
                onAttachmentAction={sources.handleAction}
                onConfigChange={props.onConfigChange}
                onClearMessages={props.onClearMessages}
                onParameterEnabledChange={props.onParameterEnabledChange}
                parameterEnabled={props.parameterEnabled}
              />
            }
          />
        </PromptInputFooter>
      </PromptInput>
      <p className='text-muted-foreground px-2 text-xs'>
        {t(
          'Images, PDF, and UTF-8 text files · up to 6 files · 8 MB each · 12 MB total · text files up to 1 MB'
        )}
      </p>
      {(attachments.busy || sources.capturingScreen) && (
        <p className='text-muted-foreground px-2 text-sm' role='status'>
          {t(
            attachments.busy
              ? 'Reading attachments…'
              : 'Select a screen or window to capture one image.'
          )}
        </p>
      )}
      {attachments.error && (
        <Alert variant='destructive'>
          <AlertDescription>{attachments.error}</AlertDescription>
        </Alert>
      )}
      {sources.cameraOpen && (
        <CameraDialog
          onClose={() => sources.setCameraOpen(false)}
          onCapture={(file) => attachments.add([file])}
          onFallback={() => sources.mobileCameraInput.current?.click()}
        />
      )}
    </div>
  )
}
