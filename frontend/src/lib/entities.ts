// Helpers for the Home Assistant entity picker (pure, so they can be tested without a DOM).

/** The domains a field accepts, from its ui.domain hint ("sensor" or ["sensor", "input_number"]). */
export function entityDomains(domain: string | string[] | undefined): string[] {
  if (!domain) return []
  return (Array.isArray(domain) ? domain : [domain]).filter(Boolean)
}

/** The state as Home Assistant shows it: "62 %", "on", "unavailable". */
export function entityReading(entity: { state?: string | null; unit?: string | null }): string {
  const state = entity.state ?? ''
  if (!state) return ''
  return entity.unit && !['unavailable', 'unknown'].includes(state) ? `${state} ${entity.unit}` : state
}

export interface Segment {
  text: string
  match: boolean
}

/** Splits text into runs that do or don't match any of the search words (case-insensitive). */
export function matchSegments(text: string, search: string): Segment[] {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean)
  if (!text) return []
  if (terms.length === 0) return [{ text, match: false }]
  const lower = text.toLowerCase()
  const marked = new Array<boolean>(text.length).fill(false)
  for (const term of terms) {
    for (let at = lower.indexOf(term); at !== -1; at = lower.indexOf(term, at + term.length)) {
      marked.fill(true, at, at + term.length)
    }
  }
  const segments: Segment[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i)
    const match = marked[i] === true
    const last = segments[segments.length - 1]
    if (last && last.match === match) last.text += char
    else segments.push({ text: char, match })
  }
  return segments
}
