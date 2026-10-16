// The Plan page's Power chart: where the house's power comes from and where it goes, stacked from zero. Into the house
// (above zero): PV, then the battery discharging. Out of it (below zero): the house load, then the battery charging,
// then the deferrable loads (the EV). The grid is not a layer: it is drawn as its own line on top, and it is exactly
// what these layers leave uncovered (import above zero, export below).

export type Values = (number | null)[]

export type FlowKey = 'pv' | 'discharge' | 'load' | 'charge' | 'deferrable'

export interface StackLayer {
  key: FlowKey
  /** The layer's outer edge: the running total from zero, negative below it. */
  edge: Values
  /** The layer it sits on (fills down to), or null for the first on its side (fills to zero). */
  on: FlowKey | null
  /** The layer's own power (positive), for the popup. */
  own: Values
}

const known = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v)

/** The layers for the flows given (W; the battery in EMHASS's sign, + discharge), in drawing order: the side above
 *  zero first, each on the one before it. A slot where no flow has a value has none in any layer (a gap); otherwise a
 *  flow without a value there counts as zero. Flows left out (null) get no layer. */
export function powerStack(flows: {
  pv?: Values | null
  battery?: Values | null
  load?: Values | null
  deferrable?: Values | null
}): StackLayer[] {
  const length = Math.max(
    flows.pv?.length ?? 0,
    flows.battery?.length ?? 0,
    flows.load?.length ?? 0,
    flows.deferrable?.length ?? 0,
  )
  const at = (values: Values | null | undefined, i: number) => values?.[i]
  const any = (i: number) =>
    known(at(flows.pv, i)) || known(at(flows.battery, i)) || known(at(flows.load, i)) || known(at(flows.deferrable, i))
  const own = (pick: (i: number) => number | null | undefined): Values =>
    Array.from({ length }, (_, i) => {
      const v = pick(i)
      return any(i) && known(v) ? Math.max(0, v) : any(i) ? 0 : null
    })
  const sides: { key: FlowKey; sign: 1 | -1; own: Values }[] = []
  if (flows.pv) sides.push({ key: 'pv', sign: 1, own: own((i) => at(flows.pv, i)) })
  if (flows.battery) {
    sides.push({ key: 'discharge', sign: 1, own: own((i) => at(flows.battery, i)) })
  }
  if (flows.load) sides.push({ key: 'load', sign: -1, own: own((i) => at(flows.load, i)) })
  if (flows.battery) {
    sides.push({
      key: 'charge',
      sign: -1,
      own: own((i) => {
        const v = at(flows.battery, i)
        return known(v) ? -v : v
      }),
    })
  }
  if (flows.deferrable) sides.push({ key: 'deferrable', sign: -1, own: own((i) => at(flows.deferrable, i)) })

  const layers: StackLayer[] = []
  for (const sign of [1, -1] as const) {
    let below: StackLayer | null = null
    for (const side of sides.filter((s) => s.sign === sign)) {
      const base: StackLayer | null = below
      const edge: Values = side.own.map((v, i) => (v === null ? null : (base?.edge[i] ?? 0) + sign * v))
      const layer: StackLayer = { key: side.key, edge, on: base?.key ?? null, own: side.own }
      layers.push(layer)
      below = layer
    }
  }
  return layers
}

/** The highest and lowest edge of the layers over slots [i0, i1), or null when there are none: the chart's y-axis
 *  must hold the stacks as well as the grid line. */
export function stackExtent(layers: StackLayer[]): [number, number] | null {
  let lo = Infinity
  let hi = -Infinity
  for (const layer of layers) {
    for (const v of layer.edge) {
      if (!known(v)) continue
      lo = Math.min(lo, v)
      hi = Math.max(hi, v)
    }
  }
  return lo <= hi ? [Math.min(lo, 0), Math.max(hi, 0)] : null
}
