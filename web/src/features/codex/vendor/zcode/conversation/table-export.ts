/* Adapted from ZCode markdown-table.tsx:73-114, Apache-2.0. See CONVERSATION-PROVENANCE.md. */
export type MarkdownTableRows = string[][]

function escapeMarkdownTableCell(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll(/\r?\n/g, '<br>')
}
function escapeCsvCell(value: string): string {
  const safeValue =
    /^[\t\r\n]/u.test(value) || /^[\s]*[=+\-@]/u.test(value)
      ? `'${value}`
      : value
  if (!/[",\r\n]/u.test(safeValue)) return safeValue
  return `"${safeValue.replaceAll('"', '""')}"`
}
export function buildMarkdownTableText(rows: MarkdownTableRows): string {
  if (rows.length === 0) return ''
  const columnCount = Math.max(...rows.map((row) => row.length), 1)
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) =>
      escapeMarkdownTableCell(row[index] ?? '')
    )
  )
  const header = normalizedRows[0] ?? []
  const separator = Array.from({ length: columnCount }, () => '---')
  const body = normalizedRows.slice(1)
  return [header, separator, ...body]
    .map((row) => `| ${row.join(' | ')} |`)
    .join('\n')
}
export function buildCsvTableText(rows: MarkdownTableRows): string {
  const csv = rows
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\r\n')
  return `\uFEFF${csv}`
}
