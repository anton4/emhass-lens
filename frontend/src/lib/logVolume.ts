// How many log lines were written per few minutes, and how many of them were warnings or errors: the strip over
// the Logs page.

export interface VolumeBucket {
  /** Unix seconds the bucket starts at. */
  start: number
  total: number
  warnings: number
  errors: number
}

/** `count` buckets of `bucketS` seconds ending at `endS`; lines outside the window are left out. */
export function logVolume(
  lines: { ts: string; level: string }[],
  endS: number,
  count = 36,
  bucketS = 300,
): VolumeBucket[] {
  const end = Math.ceil(endS / bucketS) * bucketS
  const startS = end - count * bucketS
  const buckets: VolumeBucket[] = Array.from({ length: count }, (_, i) => ({
    start: startS + i * bucketS,
    total: 0,
    warnings: 0,
    errors: 0,
  }))
  for (const line of lines) {
    const t = Date.parse(line.ts) / 1000
    const i = Math.floor((t - startS) / bucketS)
    const bucket = buckets[i]
    if (!bucket) continue
    bucket.total++
    if (line.level === 'WARNING') bucket.warnings++
    else if (line.level === 'ERROR' || line.level === 'CRITICAL') bucket.errors++
  }
  return buckets
}
