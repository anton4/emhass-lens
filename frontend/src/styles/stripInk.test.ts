import { describe, expect, it } from 'vitest'
import { chargerMark } from '../lib/charger'
import { AGREE_TONES } from '../lib/dayStrip'
import { MODE_TONES, NO_SETTINGS_FILL, NO_SETTINGS_INK } from '../lib/inverter'
import { marketMark } from '../lib/market'
import tokens from './tokens.css?raw'

// Every name the day strips write on a fill reads at 4.5:1 or better, in both themes. The fills and inks come from the
// code that draws the strips; their values from tokens.css.

type Rgb = [number, number, number]

/** The custom properties of the light theme, and of the dark one (its own over the light ones). */
function themes(css: string): Record<'light' | 'dark', Map<string, string>> {
  const darkAt = css.indexOf('@media (prefers-color-scheme: dark)')
  const props = (block: string) =>
    new Map([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.replace(/\s+/g, ' ').trim()]))
  const light = props(css.slice(0, darkAt))
  return { light, dark: new Map([...light, ...props(css.slice(darkAt))]) }
}

/** A CSS value's comma-separated parts, outside parentheses. */
function layers(value: string): string[] {
  const out = ['']
  let depth = 0
  for (const ch of value) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) out.push('')
    else out[out.length - 1] += ch
  }
  return out.map((s) => s.trim())
}

/** The colour a fill or an ink shows: a texture by the colour under it (its last layer). */
function colour(value: string, vars: Map<string, string>): Rgb {
  const parts = layers(value)
  if (parts.length > 1) return colour(parts.at(-1)!, vars)
  const v = parts[0]!
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) {
    const resolved = vars.get(ref[1]!)
    if (resolved === undefined) throw new Error(`no ${ref[1]} in tokens.css`)
    return colour(resolved, vars)
  }
  const mix = /^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/.exec(v)
  if (mix) {
    const a = colour(mix[1]!, vars)
    const b = colour(mix[3]!, vars)
    const p = Number(mix[2]) / 100
    return [0, 1, 2].map((i) => a[i]! * p + b[i]! * (1 - p)) as Rgb
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(v)
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)) as Rgb
  throw new Error(`can't read the colour of ${v}`)
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }) as Rgb
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const CHARGER = [
  "Would 'EMHASS: start charging' (emhass_start): press start",
  "Would 'EMHASS: pause charging' (emhass_pause): limit 0 A",
  "Would 'Excess solar: start charging' (solar_start): press start",
  "Would 'Excess solar: pause charging' (solar_pause): limit 0 A",
  "Did 'Target SoC reached: stop charging' (soc_limit): press stop",
  'Nothing to do: the car is unplugged',
]
const MARKET = [
  'No action: kratt none 0 W, session none → none',
  'Qilowatt safeguard: session ended (mode_cleared). Control returned to EMHASS.',
  'Qilowatt safeguard: ignored kratt mfrrup with powerlimit 0W.',
  'Something else entirely',
]

const marks = (summaries: string[], mark: (s: string) => { fill: string; ink: string | null } | null) =>
  summaries.map((s) => {
    const m = mark(s)
    if (!m?.ink) throw new Error(`no ink for "${s}"`)
    return { name: s, fill: m.fill, ink: m.ink }
  })

const PAIRS = [
  ...MODE_TONES.flatMap((t) => (t.ink ? [{ name: t.short, fill: t.fill, ink: t.ink }] : [])),
  { name: 'No settings', fill: NO_SETTINGS_FILL, ink: NO_SETTINGS_INK },
  ...Object.values(AGREE_TONES).map((t) => ({ name: t.title, fill: t.fill, ink: t.ink })),
  ...marks(CHARGER, chargerMark),
  ...marks(MARKET, marketMark),
]

describe('names on the day strips', () => {
  const vars = themes(tokens)
  for (const theme of ['light', 'dark'] as const) {
    it.each(PAIRS)(`reads at 4.5:1 or better in the ${theme} theme: $name`, ({ fill, ink }) => {
      const ratio = contrast(colour(fill, vars[theme]), colour(ink, vars[theme]))
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('puts the names on the textured fills (dots, stripes, the hatch where not in control) on a chip', () => {
    expect(MODE_TONES.filter((t) => !t.ink).map((t) => t.short)).toEqual(['Restrict export', 'Charge + export'])
    expect(marketMark('Would: Kratt sell 5000W')?.ink).toBeNull()
    expect(marketMark("Not in control (x is 'off'); would: Kratt sell 5000W")?.ink).toBeNull()
    expect(chargerMark("Not in control (charge mode is Manual); would: 'EMHASS: start charging' (emhass_start)")?.ink).toBeNull()
  })
})
