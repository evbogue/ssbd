export function parseIntParam(value: string | null | undefined, fallback = 0): number {
  if (value == null) return fallback
  const num = parseInt(String(value), 10)
  if (Number.isNaN(num) || num < 0) return fallback
  return num
}

export function filterFeedEntries(
  entries: Array<{ value?: { author?: string; sequence?: number } }>,
  author: string,
  since: number
) {
  return entries.filter(entry => {
    const value = entry?.value
    if (!value) return false
    if (value.author !== author) return false
    if (typeof value.sequence !== 'number') return false
    return value.sequence > since
  })
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}
