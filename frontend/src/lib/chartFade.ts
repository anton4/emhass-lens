// A chart drawn faded on one side of a moment (the plan right of now, the measured part before the anchor): where the
// split falls along the canvas, the gradient's stops, and a colour at a share of its own opacity.

/** The side of the split that is drawn faded. */
export type FadeSide = 'before' | 'after'

/** Where `atPx` falls along a gradient from `left` across `width` (canvas px), as 0–1. */
export function splitOffset(atPx: number, left: number, width: number): number {
  if (!(width > 0)) return 0
  return Math.min(1, Math.max(0, (atPx - left) / width))
}

/** A gradient's stops as [offset, opacity share]: full on one side of `offset`, `fade` on the other, with a hard edge
 *  at the split. */
export function fadeStops(offset: number, side: FadeSide, fade: number): [number, number][] {
  const [left, right] = side === 'after' ? [1, fade] : [fade, 1]
  return [
    [0, left],
    [offset, left],
    [offset, right],
    [1, right],
  ]
}

/** Is a span [from, to) entirely on the faded side of a split at `at`? */
export function onFadedSide(from: number, to: number, at: number, side: FadeSide): boolean {
  return side === 'after' ? from >= at : to <= at
}

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i
const RGB = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i

/** `color` (#rrggbb, #rrggbbaa, rgb() or rgba()) at `share` of its own opacity; other colour strings come back as they
 *  are. */
export function scaleAlpha(color: string, share: number): string {
  const c = color.trim()
  let r: number, g: number, b: number, a: number
  const hex = HEX.exec(c)
  const rgb = hex ? null : RGB.exec(c)
  if (hex) {
    r = parseInt(hex[1]!, 16)
    g = parseInt(hex[2]!, 16)
    b = parseInt(hex[3]!, 16)
    a = hex[4] === undefined ? 1 : parseInt(hex[4], 16) / 255
  } else if (rgb) {
    r = Number(rgb[1])
    g = Number(rgb[2])
    b = Number(rgb[3])
    const raw = rgb[4]
    a = raw === undefined ? 1 : raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw)
  } else {
    return color
  }
  const alpha = Math.round(Math.min(1, Math.max(0, a * share)) * 1000) / 1000
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
