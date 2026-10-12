// A filter that keeps or leaves out several values, in the URL as a repeated key: ?job=a&job=b keeps a and b,
// ?not_job=a&not_job=b leaves them out. The API takes the same keys.

export interface MultiValue {
  values: string[]
  exclude: boolean
}

export function readMulti(params: URLSearchParams, key: string): MultiValue {
  const excluded = params.getAll(`not_${key}`).filter(Boolean)
  if (excluded.length > 0) return { values: excluded, exclude: true }
  return { values: params.getAll(key).filter(Boolean), exclude: false }
}

export function writeMulti(params: URLSearchParams, key: string, { values, exclude }: MultiValue): void {
  params.delete(key)
  params.delete(`not_${key}`)
  for (const value of values) params.append(exclude ? `not_${key}` : key, value)
}

/** The filter as API params: `{ job: [...] }` or `{ not_job: [...] }`, nothing when no value is picked. */
export function multiQuery(key: string, { values, exclude }: MultiValue): Record<string, string[]> {
  return values.length > 0 ? { [exclude ? `not_${key}` : key]: values } : {}
}

/** The filter button's text: "All jobs", "MPC run", "3 jobs", "All but MPC run" or "All but 3 jobs". */
export function multiSummary(noun: string, labels: string[], exclude: boolean): string {
  if (labels.length === 0) return `All ${noun}`
  const picked = labels.length > 1 ? `${labels.length} ${noun}` : (labels[0] ?? '')
  return exclude ? `All but ${picked}` : picked
}
