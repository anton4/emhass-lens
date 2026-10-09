# Changelog

## 0.2.0

The first version meant for trying on a real Home Assistant, next to the HACS integration.

- **Plan:** shows what EMHASS wants for this slot, with charts of power, SOC (and the previous plan) and prices.
- **Inputs:**
  - Nord Pool prices per delivery day, with the reason for every fetch, and the full per-slot tariff breakdown (Elektrilevi packages, winter peaks, holidays, night window).
  - Price forecasts (eupowerprices.com or nordpool-predict-fi) and the Solcast PV forecast.
  - Every value the MPC uses, with where it came from and how old it is.
- **Runs:** every job with its inputs, the payload sent, an Explain table, EMHASS's response and its log lines. Any run can be downloaded as one file.
- **Modes:**
  - **Off:** shadow builds every quarter-hour.
  - **Dry run:** all checks, nothing sent.
  - **Live:** sends to EMHASS, verifies the plan, then publishes at each slot start and fires `emhass_lens_plan_published`.
- **Take over / Hand back:** switches the HACS integration's Auto MPC and EMHASS Lens together, in one step.
- **Parity:** compares prices, PV and payloads with the HACS integration every quarter-hour.
- **Health:** EMHASS discovery, configuration checks, problems with history, and Home Assistant notifications.
- **ML:** fit, tune and predict on demand.
- **MQTT entities:** import/export price now, problem, last MPC, an Auto MPC switch and a Run MPC button.
- **Inverter control (experimental, off by default):** decides each slot like the "EMHASS: Consolidated Inverter Control" automation, and in dry run compares with what the automation did.

## 0.1.0

- First build: App packaging, settings with change history, scheduler, run records, live logs.
