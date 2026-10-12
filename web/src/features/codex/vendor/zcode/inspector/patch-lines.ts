/*
 * getPatchPreviewLineContent is from ZCode, Copyright ZCode contributors.
 * SPDX-License-Identifier: Apache-2.0
 * Upstream: zai-org/ZCode@29628c9acdb81b703bbd4080c207a0e7ce5e276e
 * Original: packages/ui/src/lib/patchDiffPreview.ts
 * parseUnifiedDiffLines is a New API adapter preserving actual source line
 * numbers and metadata when reading the existing Codex unified diff API.
 */
export function getPatchPreviewLineContent(line: string): string {
  if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
    return line.slice(1)
  }
  return line
}

export function parseUnifiedDiffLines(patch: string): {
  lines: string[]
  lineNumbers: (number | string)[]
  added: number
  removed: number
} {
  const lines: string[] = []
  const lineNumbers: (number | string)[] = []
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let added = 0
  let removed = 0
  for (const line of patch.split(/\r?\n/)) {
    const range = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (range) {
      oldLine = Number(range[1])
      newLine = Number(range[2])
      inHunk = true
      lines.push(line)
      lineNumbers.push('')
      continue
    }
    if (!inHunk && /^(diff --git |index |--- |\+\+\+ )/.test(line)) continue
    if (!line) continue
    lines.push(line)
    if (inHunk && line.startsWith('+')) {
      lineNumbers.push(newLine++)
      added++
    } else if (inHunk && line.startsWith('-')) {
      lineNumbers.push(oldLine++)
      removed++
    } else if (inHunk && line.startsWith(' ')) {
      oldLine++
      lineNumbers.push(newLine++)
    } else lineNumbers.push('')
  }
  return { lines, lineNumbers, added, removed }
}
