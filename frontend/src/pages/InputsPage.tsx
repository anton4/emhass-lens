import { PageHead } from '../components/PageHead'

export function InputsPage() {
  return (
    <>
      <PageHead
        title="Inputs"
        intro="Everything EMHASS is fed, each value with where it came from and how old it is. Arrives in Phase 1."
      />
      <div className="phase">
        <section className="panel">
          <div className="panel-head">
            <h2>Prices</h2>
          </div>
          <div className="panel-body">
            <ul>
              <li>Nord Pool day-ahead prices for today and tomorrow, Preliminary or Final, per delivery day.</li>
              <li>Import and export price for every quarter-hour, broken down into spot, network, fees and VAT.</li>
              <li>Why a slot uses the night or peak rate: weekend, holiday or time of day.</li>
            </ul>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Forecasts and sensors</h2>
          </div>
          <div className="panel-body">
            <ul>
              <li>The price forecast that extends the horizon, and how far off it was once real prices came out.</li>
              <li>Solcast PV per quarter-hour, with any missing hours flagged instead of filled with zeros.</li>
              <li>Battery state of charge, target and EV inputs, each with its entity, raw state and age.</li>
            </ul>
          </div>
        </section>
      </div>
    </>
  )
}
