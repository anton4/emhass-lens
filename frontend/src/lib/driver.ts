import type { LampColor } from '../components/Lamp'

/** status.driver (app | legacy | both | none) as lamp, label and explanation. */
export function driverSpec(driver: string): { color: LampColor; text: string; explain: string } {
  switch (driver) {
    case 'app':
      return { color: 'green', text: 'EMHASS Lens', explain: 'EMHASS Lens sends the MPC runs and publishes the plan.' }
    case 'legacy':
      return {
        color: 'blue',
        text: 'HACS integration',
        explain: 'The HACS integration still runs MPC. EMHASS Lens builds its own payloads alongside and compares them.',
      }
    case 'both':
      return {
        color: 'red',
        text: 'Both — conflict',
        explain: 'EMHASS Lens live mode and the HACS integration Auto MPC are both on; EMHASS gets runs from both.',
      }
    default:
      return { color: 'neutral', text: 'Nobody', explain: 'Nothing sends scheduled MPC runs to EMHASS right now.' }
  }
}
