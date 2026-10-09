# Changelog

## Unreleased

- Inverter control: the rules now follow the current, template-based version of the automation "EMHASS: Consolidated Inverter Control": ±100 W bands for grid and battery power, "Charge battery and export some to grid" can match, PV export depends on the export price, and the feed-in limit depends only on the export price. Every combination of grid and battery power now maps to a mode. Rule ids are the automation's mode names (`force_charge`, `self_use`, …).
- Settings → Inverter control → Limits: "Block export at or below this price" replaces "Block export below this price" and now defaults to 0.03 €/kWh. An existing install keeps its stored value; set it to the automation's value by hand.
- DOCS: a section on inverter control and how to move the automation over.

## 0.2.10

- Parity: when only the slots filled from the price forecast differ because the two sides fetched the forecast at different times, the check passes and says so, with both fetch times. Differences in Nord Pool prices are still reported.
- Health → Getting started: the "open" links to cards on the Health page now scroll to that card instead of doing nothing.

## 0.2.9

- Inputs → Price breakdown: click Spot, Fees, Network or VAT in the legend to show or hide that part; the chart rescales to what is shown and remembers the choice in this browser.

## 0.2.8

- The eye button on secret fields (the eupowerprices.com API key, the MQTT broker password) can also show the stored value. It works only when EMHASS Lens is opened from the Home Assistant sidebar, and each reveal is logged without the value.

## 0.2.7

- Plan charts: each y-axis fits its own data (Battery SOC is no longer always 0–100 %). Drag across a chart to zoom all three into that time range; double-click or "Reset zoom" shows the whole plan again.
- Secret fields such as the eupowerprices.com API key have an eye button that shows what you typed.

## 0.2.6

- Settings: the review before saving names each change by its place in the form; click one to jump to the field. Changed fields are highlighted, and each one can be reverted on its own, from the form or from the review. Discard all is also offered while reviewing.

## 0.2.5

- Saving settings and switching the mode work behind reverse proxies that only allow GET and POST (they failed with "Failed to fetch").
- After a start or update, Home Assistant shows the App as started within seconds instead of after a minute.

## 0.2.4

Fixes from a code review:
- **Nord Pool polling:** never runs more than once a minute, and backs off when an already-delivered day has no prices or the response is malformed.
- **Inverter control:**
  - decides right after EMHASS Lens publishes, and ignores EMHASS sensors left over from the previous slot
  - in live mode, re-reads the passive-mode and mFRR interlocks before writing, and refuses without a Home Assistant connection
- **MPC runs:** EMHASS's status is only trusted when its last run is newer than the request, and a missing plan read-back counts as an error.
- **MQTT:** entities show as unavailable when EMHASS Lens stops, and are removed when MQTT entities are turned off.
- **Take over:** a stale page can no longer leave nobody driving EMHASS.
- **Entity list:** only available through the Home Assistant sidebar (the optional direct port has no login).

## 0.2.3

- Entity fields in Settings search Home Assistant as you type: matches are listed best first with their current value, also on installs with thousands of entities.
- The log no longer shows every Home Assistant WebSocket message at debug level while the log level is info.

## 0.2.2

- Health page: a getting-started checklist that shows how far the move from the HACS integration is, step by step, with links.

## 0.2.1

- The Plan page's "This slot" shows the row EMHASS publishes right now (the next slot between a :13 run and the slot start) instead of saying the plan doesn't cover it.

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
