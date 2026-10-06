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
import type { PlaygroundAttachment } from '../types'

export const ATTACHMENT_LIMITS = {
  count: 6,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 12 * 1024 * 1024,
  textBytes: 1024 * 1024,
} as const
const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])
const textExtensions = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'sh',
  'sql',
])
export const ATTACHMENT_ACCEPT =
  '.png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.md,.markdown,.json,.csv,.log,.yaml,.yml,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.c,.h,.cpp,.sh,.sql'
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

export class AttachmentError extends Error {
  constructor(
    public readonly key: string,
    public readonly fileName = ''
  ) {
    super(key)
  }
}

function readFile(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const failure = () =>
      reject(
        new AttachmentError(
          'Unable to read {{name}}. Please select the file again.',
          file.name
        )
      )
    reader.addEventListener(
      'load',
      () => {
        if (reader.result instanceof ArrayBuffer) resolve(reader.result)
        else failure()
      },
      { once: true }
    )
    reader.addEventListener('error', failure, { once: true })
    reader.addEventListener('abort', failure, { once: true })
    reader.readAsArrayBuffer(file)
  })
}

function attachmentType(file: File): {
  kind: PlaygroundAttachment['kind']
  mimeType: string
} {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? ''
  const type = file.type.toLowerCase()
  const imageByExtension: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  }
  const inferred = type || imageByExtension[extension]
  if (imageTypes.has(inferred)) return { kind: 'image', mimeType: inferred }
  if (type === 'application/pdf' || (!type && extension === 'pdf')) {
    return { kind: 'pdf', mimeType: 'application/pdf' }
  }
  if (
    textExtensions.has(extension) &&
    (!type ||
      type.startsWith('text/') ||
      [
        'application/json',
        'application/xml',
        'application/x-yaml',
        'application/yaml',
        'application/javascript',
        'application/octet-stream',
      ].includes(type))
  ) {
    return { kind: 'text', mimeType: type || 'text/plain' }
  }
  throw new AttachmentError(
    'Unsupported file type: {{name}}. Use an image, PDF, or text file.',
    file.name
  )
}

function verifySignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === 'application/pdf') {
    return new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-'
  }
  if (mimeType === 'image/png') {
    return [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value
    )
  }
  if (mimeType === 'image/jpeg') {
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  }
  if (mimeType === 'image/gif') {
    return ['GIF87a', 'GIF89a'].includes(
      new TextDecoder().decode(bytes.subarray(0, 6))
    )
  }
  if (mimeType === 'image/webp') {
    return (
      new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP'
    )
  }
  return false
}

export async function prepareAttachments(
  files: File[],
  current: PlaygroundAttachment[]
): Promise<PlaygroundAttachment[]> {
  if (files.length + current.length > ATTACHMENT_LIMITS.count) {
    throw new AttachmentError('You can attach up to 6 files per message.')
  }
  if (
    files.reduce(
      (sum, file) => sum + file.size,
      current.reduce((sum, item) => sum + item.size, 0)
    ) > ATTACHMENT_LIMITS.totalBytes
  ) {
    throw new AttachmentError('Attachments must total 12 MB or less.')
  }
  const descriptors = files.map((file) => {
    if (!file.size) {
      throw new AttachmentError(
        '{{name}} is empty. Choose a file with content.',
        file.name
      )
    }
    if (file.size > ATTACHMENT_LIMITS.fileBytes) {
      throw new AttachmentError(
        '{{name}} exceeds the 8 MB file limit.',
        file.name
      )
    }
    const descriptor = attachmentType(file)
    if (descriptor.kind === 'text' && file.size > ATTACHMENT_LIMITS.textBytes) {
      throw new AttachmentError(
        '{{name}} exceeds the 1 MB text file limit.',
        file.name
      )
    }
    return descriptor
  })
  return Promise.all(
    files.map(async (file, index) => {
      const descriptor = descriptors[index]
      const buffer = await readFile(file)
      const bytes = new Uint8Array(buffer)
      const attachment: PlaygroundAttachment = {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        ...descriptor,
      }
      if (descriptor.kind === 'text') {
        try {
          attachment.text = new TextDecoder('utf-8', { fatal: true }).decode(
            bytes
          )
        } catch {
          throw new AttachmentError(
            '{{name}} is not a valid UTF-8 text file.',
            file.name
          )
        }
        if (attachment.text.includes('\0')) {
          throw new AttachmentError(
            '{{name}} is not a valid UTF-8 text file.',
            file.name
          )
        }
      } else {
        if (!verifySignature(bytes, descriptor.mimeType)) {
          throw new AttachmentError(
            '{{name}} does not match its image or PDF file type.',
            file.name
          )
        }
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          binary += String.fromCharCode(
            ...bytes.subarray(offset, offset + 32768)
          )
        }
        attachment.dataUrl = `data:${descriptor.mimeType};base64,${btoa(binary)}`
      }
      return attachment
    })
  )
}
