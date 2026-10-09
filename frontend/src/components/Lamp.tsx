export type LampColor = 'green' | 'amber' | 'red' | 'blue' | 'neutral'

interface LampProps {
  color: LampColor
  lit?: boolean
  pulse?: boolean
  label?: string
}

/** A pilot light. Colour is never the only signal: pass a label or render text next to it. */
export function Lamp({ color, lit = true, pulse = false, label }: LampProps) {
  return (
    <span
      className="lamp"
      data-color={color}
      data-lit={lit}
      data-pulse={pulse}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}

export function LabelledLamp({ color, text, pulse }: { color: LampColor; text: string; pulse?: boolean }) {
  return (
    <span className="labelled-lamp">
      <Lamp color={color} pulse={pulse} />
      {text}
    </span>
  )
}
