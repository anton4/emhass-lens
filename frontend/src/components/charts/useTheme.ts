import { useEffect, useState } from 'react'

/** Increments when the colour scheme flips, so canvas charts can re-read their CSS colours. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setVersion((v) => v + 1)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])
  return version
}

/** Resolve "--series-1" (or any CSS colour) to a concrete colour string for canvas drawing. */
export function cssColor(value: string): string {
  if (!value.startsWith('--')) return value
  return getComputedStyle(document.documentElement).getPropertyValue(value).trim() || '#888'
}
