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

/** A hex colour ("#2a78d6", as the tokens are) at `alpha` opacity; other colour strings come back unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color.trim())
  if (!m) return color
  return `rgba(${parseInt(m[1]!, 16)}, ${parseInt(m[2]!, 16)}, ${parseInt(m[3]!, 16)}, ${alpha})`
}

/** Resolve "--series-1" (or any CSS colour) to a concrete colour string for canvas drawing. */
export function cssColor(value: string): string {
  if (!value.startsWith('--')) return value
  return getComputedStyle(document.documentElement).getPropertyValue(value).trim() || '#888'
}
