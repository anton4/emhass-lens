// The pages in their navigation groups. The top bar's tabs, the command palette and the
// "g then a letter" shortcuts all read this one list.

export interface NavPage {
  to: string
  label: string
  /** Second key after "g" that opens the page. */
  key?: string
  experimental?: boolean
}

export interface NavGroup {
  label: string
  pages: NavPage[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Operate',
    pages: [
      { to: '/', label: 'Plan', key: 'p' },
      { to: '/inputs', label: 'Inputs', key: 'i' },
    ],
  },
  {
    label: 'Control',
    pages: [
      { to: '/inverter', label: 'Inverter', experimental: true },
      { to: '/charger', label: 'EV charger', experimental: true },
      { to: '/market', label: 'Market', experimental: true },
    ],
  },
  {
    label: 'Diagnose',
    pages: [
      { to: '/runs', label: 'Runs', key: 'r' },
      { to: '/logs', label: 'Logs', key: 'l' },
      { to: '/health', label: 'Health', key: 'h' },
    ],
  },
  {
    label: 'Configure',
    pages: [{ to: '/settings', label: 'Settings', key: 's' }],
  },
]

export const NAV_PAGES: NavPage[] = NAV_GROUPS.flatMap((g) => g.pages)

/** The page a "g" shortcut letter opens. */
export function pageForKey(key: string): NavPage | undefined {
  return NAV_PAGES.find((p) => p.key === key.toLowerCase())
}
