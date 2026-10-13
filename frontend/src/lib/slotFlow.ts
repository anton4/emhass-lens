// The Plan page's "This slot" as a flow: PV at the top, the grid on the left, the battery on the right, the house and
// the deferrable load (the EV) below, each joined to one point. What is measured is the big number and the plan the
// line under it; the lines are as thick as the power and point the way it flows. EMHASS's signs: P_batt > 0
// discharges, P_grid > 0 imports.

import type { ChargerNow, PlanPrice, PlanRow } from '../api/types'
import { dayKey } from './format'
import { deferrableColumns, num } from './plan'
import type { NowByKey } from './planNow'
import { IDLE_W } from './planSummary'
import { formatFraction, formatPower, isNumber } from './units'

export type FlowKey = 'pv' | 'grid' | 'batt' | 'load' | 'ev'
export type FlowValues = Record<FlowKey, number | null>
export type FlowDir = 'r' | 'l' | 'u' | 'd'

/** The power drawn with the thickest line. */
const FULL_W = 20_000

const pos = (w: number | null) => w !== null && w >= IDLE_W
const neg = (w: number | null) => w !== null && w <= -IDLE_W

/** A plan row's powers; the deferrable loads together. */
export function planValues(row: PlanRow, columns: string[]): FlowValues {
  const deferrables = deferrableColumns(columns)
  const ev = deferrables.length ? deferrables.reduce((sum, c) => sum + (num(row, c) ?? 0), 0) : null
  return { pv: num(row, 'P_PV'), grid: num(row, 'P_grid'), batt: num(row, 'P_batt'), load: num(row, 'P_Load'), ev }
}

/** What the Measurements sensors read (or their quarter-hour means), and the EV charger's power while it charges. */
export function measuredValues(now: NowByKey | undefined, charger?: ChargerNow | null): FlowValues {
  const m = (key: 'pv' | 'grid' | 'batt' | 'load') => {
    const v = now?.[key]?.measured
    return isNumber(v) ? v : null
  }
  const ev = charger?.power_w
  return { pv: m('pv'), grid: m('grid'), batt: m('batt'), load: m('load'), ev: isNumber(ev) ? ev : null }
}

/** The way a power flows, in a word ("" for the house: it only ever uses power). */
export function direction(key: FlowKey, w: number | null): string {
  if (w === null) return ''
  if (key === 'pv') return pos(w) ? 'producing' : 'not producing'
  if (key === 'grid') return pos(w) ? 'importing' : neg(w) ? 'exporting' : 'no flow'
  if (key === 'batt') return pos(w) ? 'discharging' : neg(w) ? 'charging' : 'idle'
  if (key === 'ev') return pos(w) ? 'charging' : 'off'
  return ''
}

/** What the EV charger says it does, when its controller is on. */
function chargerDirection(charger: ChargerNow | null | undefined): string | null {
  const state = charger?.state_raw
  if (!charger || !isNumber(state) || state < 0) return null
  if (state === 0) return 'unplugged'
  if (state === 4) return isNumber(charger.current_limit_a) ? `charging at ${charger.current_limit_a} A` : 'charging'
  return 'plugged in'
}

/** The slot in one line, from what flows where: "Charging the battery from the grid". */
export function flowHeadline(v: FlowValues, deferrable = 'the EV'): string {
  const pv = pos(v.pv)
  const ev = pos(v.ev)
  const users = ev ? `the house and ${deferrable}` : 'the house'
  if (neg(v.batt)) {
    const what = ev ? `the battery and ${deferrable}` : 'the battery'
    if (pv && neg(v.grid)) return `Charging ${what} from PV, exporting the rest`
    if (pv && pos(v.grid)) return `Charging ${what} from PV and the grid`
    if (pv) return `Charging ${what} from PV`
    return `Charging ${what} from the grid`
  }
  if (pos(v.batt)) {
    if (neg(v.grid)) return 'Discharging the battery to the grid'
    if (pos(v.grid)) return `The battery and the grid cover ${users}`
    if (pv) return `The battery and PV cover ${users}`
    return `The battery covers ${users}`
  }
  if (pv && neg(v.grid)) return `PV covers ${users}, exporting the rest`
  if (pv && pos(v.grid)) return `PV and the grid cover ${users}`
  if (pv) return `PV covers ${users}`
  if (pos(v.grid)) return `The grid covers ${users}`
  if (neg(v.grid)) return 'Exporting to the grid'
  return 'Nothing flows'
}

const JUDGED = [
  ['batt', 'battery'],
  ['grid', 'grid'],
  ['soc', 'SOC'],
] as const

/** "as planned", or which of what the inverter controls differs from the plan; null when nothing was judged. */
export function agreement(now: NowByKey | undefined): { color: 'green' | 'amber'; text: string } | null {
  const judged = JUDGED.filter(([key]) => typeof now?.[key]?.differs === 'boolean')
  if (judged.length === 0) return null
  const off = judged.filter(([key]) => now?.[key]?.differs).map(([, name]) => name)
  if (off.length === 0) return { color: 'green', text: 'as planned' }
  const list = off.length === 1 ? off[0]! : `${off.slice(0, -1).join(', ')} and ${off[off.length - 1]}`
  return {
    color: 'amber',
    text: `${list[0]!.toUpperCase()}${list.slice(1)} ${off.length === 1 ? 'differs' : 'differ'} from the plan`,
  }
}

export interface FlowNode {
  key: FlowKey
  label: string
  /** The quantity's colour token ("--q-batt"). */
  quantity: string
  /** The big number: what is measured, else the plan; null when neither is known. */
  value: string | null
  direction: string
  measured: boolean
  /** The plan under a measured value ("plan 12.69 kW", with its direction when that differs), or "planned" /
   *  "forecast" when the big number is the plan; PV's curtailment after it. */
  plan: string | null
  idle: boolean
  /** The state of charge beside the power: the battery's, or the car's in the EV box. */
  soc: NodeSoc | null
}

export interface NodeSoc {
  text: string
  /** Read from a sensor (else it is the plan's, for the end of the slot). */
  measured: boolean
  /** What it is, for its hover text. */
  note: string
  differs: boolean
}

/** The battery's measured state of charge (0–1), else the plan's at the end of the slot. */
function batterySoc(soc: { measured: number | null; planned: number | null; differs?: boolean | null }): NodeSoc | null {
  const measured = isNumber(soc.measured)
  const value = measured ? soc.measured : soc.planned
  if (!isNumber(value)) return null
  return {
    text: formatFraction(value, 0),
    measured,
    note: measured ? 'State of charge' : 'State of charge the plan expects at the end of the slot',
    differs: measured && soc.differs === true,
  }
}

/** The car's battery level (%), from its sensor under the charger's entities. */
function carSoc(charger: ChargerNow | null | undefined): NodeSoc | null {
  const soc = charger?.soc
  if (!isNumber(soc)) return null
  const target = charger?.target_soc
  return {
    text: formatFraction(soc / 100, 0),
    measured: true,
    note: `The car's battery level${isNumber(target) ? `, target ${Math.round(target)} %` : ''}`,
    differs: false,
  }
}

const QUANTITY: Record<FlowKey, string> = {
  pv: '--q-pv',
  grid: '--q-grid',
  batt: '--q-batt',
  load: '--q-load',
  ev: '--q-ev',
}

/** One box per quantity; the deferrable load's only when the plan has one (`deferrable` names it). `soc` is the
 *  battery's state of charge (0–1): measured, the plan's at the end of the slot, and whether it differs. */
export function flowNodes(
  plan: FlowValues,
  measured: FlowValues,
  opts: {
    deferrable: string | null
    curtailed?: number | null
    charger?: ChargerNow | null
    soc?: { measured: number | null; planned: number | null; differs?: boolean | null }
  },
): FlowNode[] {
  const labels: Record<FlowKey, string | null> = {
    pv: 'PV',
    grid: 'Grid',
    batt: 'Battery',
    load: 'House',
    ev: opts.deferrable,
  }
  const nodes: FlowNode[] = []
  for (const key of ['pv', 'grid', 'batt', 'load', 'ev'] as const) {
    const label = labels[key]
    if (!label) continue
    const p = plan[key]
    const m = measured[key]
    const shown = m ?? p
    const flow = direction(key, shown)
    const dir = key === 'ev' && m !== null ? (chargerDirection(opts.charger) ?? flow) : flow
    const word = key === 'pv' || key === 'load' ? 'forecast' : 'plan'
    const curtailed =
      key === 'pv' && isNumber(opts.curtailed) && opts.curtailed >= IDLE_W
        ? `${formatPower(opts.curtailed)} curtailed`
        : null
    let planText: string | null = null
    if (m !== null && p !== null) {
      const planDir = direction(key, p)
      planText = `${word} ${formatPower(Math.abs(p))}${planDir && planDir !== flow ? ` ${planDir}` : ''}`
    } else if (p !== null) {
      planText = word === 'plan' ? 'planned' : 'forecast' // nothing measured: the big number is the plan
    }
    if (planText && curtailed) planText += `, ${curtailed}`
    nodes.push({
      key,
      label,
      quantity: QUANTITY[key],
      value: shown === null ? null : formatPower(Math.abs(shown)),
      direction: dir,
      measured: m !== null,
      plan: planText,
      idle: shown === null || Math.abs(shown) < IDLE_W,
      soc: key === 'batt' && opts.soc ? batterySoc(opts.soc) : key === 'ev' ? carSoc(opts.charger) : null,
    })
  }
  return nodes
}

/** Where the boxes sit and how thick the lines get. `at.loadAlone` places the house when there is no deferrable
 *  load; with one, the house and the deferrable load share the bottom row. */
export interface FlowLayout {
  width: number
  height: number
  node: { w: number; h: number }
  hub: { x: number; y: number }
  /** The y of the line that splits towards the house and the deferrable load. */
  bus: number
  at: Record<FlowKey | 'loadAlone', { x: number; y: number }>
  /** The thinnest and the thickest line, px. */
  thick: [number, number]
  /** An arrow's length along its line, and how far it reaches past the line on each side. */
  arrow: [number, number]
}

export const WIDE_FLOW: FlowLayout = {
  width: 720,
  height: 416,
  node: { w: 176, h: 116 },
  hub: { x: 360, y: 194 },
  bus: 252,
  at: {
    pv: { x: 272, y: 0 },
    grid: { x: 0, y: 136 },
    batt: { x: 544, y: 136 },
    load: { x: 168, y: 300 },
    ev: { x: 376, y: 300 },
    loadAlone: { x: 272, y: 300 },
  },
  thick: [3, 16],
  arrow: [11, 5],
}

/** For less room than WIDE_FLOW needs; fits a 360 px phone with 16 px gutters (scaled down below that). */
export const NARROW_FLOW: FlowLayout = {
  width: 328,
  height: 372,
  node: { w: 106, h: 104 },
  hub: { x: 164, y: 172 },
  bus: 226,
  at: {
    pv: { x: 111, y: 0 },
    grid: { x: 0, y: 120 },
    batt: { x: 222, y: 120 },
    load: { x: 50, y: 268 },
    ev: { x: 172, y: 268 },
    loadAlone: { x: 111, y: 268 },
  },
  thick: [2, 11],
  arrow: [9, 4],
}

/** One straight piece of line, `from` its left (or top) end, and which way the power runs along it. */
export interface FlowSegment {
  key: string
  from: [number, number]
  to: [number, number]
  watts: number | null
  dir: FlowDir
  color: string
  arrow: boolean
}

export function flowSegments(v: FlowValues, layout: FlowLayout, withDeferrable: boolean): FlowSegment[] {
  const { hub, node, at, bus } = layout
  const abs = (w: number | null) => (w === null ? null : Math.abs(w))
  const segments: FlowSegment[] = [
    { key: 'pv', from: [hub.x, at.pv.y + node.h], to: [hub.x, hub.y], watts: v.pv, dir: 'd', color: 'var(--q-pv)', arrow: true },
    {
      key: 'grid',
      from: [at.grid.x + node.w, hub.y],
      to: [hub.x, hub.y],
      watts: abs(v.grid),
      dir: neg(v.grid) ? 'l' : 'r',
      color: 'var(--q-grid)',
      arrow: true,
    },
    {
      key: 'batt',
      from: [hub.x, hub.y],
      to: [at.batt.x, hub.y],
      watts: abs(v.batt),
      dir: pos(v.batt) ? 'l' : 'r',
      color: 'var(--q-batt)',
      arrow: true,
    },
  ]
  if (!withDeferrable) {
    segments.push({
      key: 'load',
      from: [hub.x, hub.y],
      to: [hub.x, at.loadAlone.y],
      watts: abs(v.load),
      dir: 'd',
      color: 'var(--q-load)',
      arrow: true,
    })
    return segments
  }
  const lx = at.load.x + node.w / 2
  const ex = at.ev.x + node.w / 2
  const both = v.load === null && v.ev === null ? null : Math.abs(v.load ?? 0) + Math.abs(v.ev ?? 0)
  segments.push(
    { key: 'users', from: [hub.x, hub.y], to: [hub.x, bus], watts: both, dir: 'd', color: 'var(--ink-faint)', arrow: false },
    { key: 'load-bus', from: [lx, bus], to: [hub.x, bus], watts: abs(v.load), dir: 'l', color: 'var(--q-load)', arrow: false },
    { key: 'load', from: [lx, bus], to: [lx, at.load.y], watts: abs(v.load), dir: 'd', color: 'var(--q-load)', arrow: true },
    { key: 'ev-bus', from: [hub.x, bus], to: [ex, bus], watts: abs(v.ev), dir: 'r', color: 'var(--q-ev)', arrow: false },
    { key: 'ev', from: [ex, bus], to: [ex, at.ev.y], watts: abs(v.ev), dir: 'd', color: 'var(--q-ev)', arrow: true },
  )
  return segments
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

const CLIP: Record<FlowDir, string> = {
  r: 'polygon(0 0, 100% 50%, 0 100%)',
  l: 'polygon(100% 0, 0 50%, 100% 100%)',
  d: 'polygon(0 0, 100% 0, 50% 100%)',
  u: 'polygon(50% 0, 100% 100%, 0 100%)',
}

/** A segment as a box: as thick as its power with rounded ends past its corners, or a hairline (`idle`) when
 *  nothing flows; with its arrow in the middle. */
export function segmentBox(
  segment: FlowSegment,
  layout: FlowLayout,
): { line: Box; idle: boolean; arrow: (Box & { clip: string }) | null } {
  const [x1, y1] = segment.from
  const [x2, y2] = segment.to
  const horizontal = y1 === y2
  const w = segment.watts
  if (w === null || w < IDLE_W) {
    return {
      line: horizontal ? { left: x1, top: y1, width: x2 - x1, height: 0 } : { left: x1, top: y1, width: 0, height: y2 - y1 },
      idle: true,
      arrow: null,
    }
  }
  const [thin, thick] = layout.thick
  const t = Math.round(thin + ((thick - thin) * Math.min(w, FULL_W)) / FULL_W)
  const line = horizontal
    ? { left: x1 - t / 2, top: y1 - t / 2, width: x2 - x1 + t, height: t }
    : { left: x1 - t / 2, top: y1 - t / 2, width: t, height: y2 - y1 + t }
  if (!segment.arrow) return { line, idle: false, arrow: null }
  const [length, reach] = layout.arrow
  const breadth = t + 2 * reach
  const mx = (x1 + x2) / 2
  const my = (y1 + y2) / 2
  const arrow = horizontal
    ? { left: mx - length / 2, top: my - breadth / 2, width: length, height: breadth, clip: CLIP[segment.dir] }
    : { left: mx - breadth / 2, top: my - length / 2, width: breadth, height: length, clip: CLIP[segment.dir] }
  return { line, idle: false, arrow }
}

/** Seconds as a short age: "12 s", "5 min", "3 h", "2 d". */
export function shortAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  return `${Math.floor(s / 86400)} d`
}

/** Where an import price sits within its day's prices: 0 the cheapest, 1 the dearest. Null without a spread. */
export function priceInDay(
  prices: PlanPrice[],
  slotStart: string,
  importPrice: number | null,
  timeZone?: string,
): { min: number; max: number; position: number; word: string } | null {
  if (importPrice === null) return null
  const day = dayKey(new Date(slotStart), timeZone)
  const same = prices.filter((p) => dayKey(new Date(p.start), timeZone) === day).map((p) => p.import_price)
  if (same.length < 2) return null
  const min = Math.min(...same, importPrice)
  const max = Math.max(...same, importPrice)
  if (max - min < 1e-9) return null
  const position = (importPrice - min) / (max - min)
  const word = position < 1 / 3 ? 'cheap for today' : position > 2 / 3 ? 'expensive for today' : 'mid-range for today'
  return { min, max, position, word }
}
