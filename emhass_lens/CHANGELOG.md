# Changelog

## 0.3.12

- EMHASS's solver gets a time limit per optimisation from the time left before the next publish (the live plan most of it, cost-function comparison steps at most 30 s), and a live solve that stops at its limit is retried once with a 5 % MIP gap, so EMHASS ends with a live plan instead of a comparison plan. A solver error without a message is explained ("stopped at its time limit"). Settings → EMHASS → MPC optimization → *Solver time limit*.
- MPC now runs at 11:00 into each quarter instead of 13:00, for about four minutes of solver time; a changed time is kept.
- "Kept in sync" no longer runs into the next column on the Inverter and EV charger pages.

## 0.3.11

- The Plan page shows prices in €/kWh instead of cents: the price chart, the import and export price of this slot, and the price forecast's error on the accuracy card.

## 0.3.10

- When Home Assistant comes back (a restart, a host reboot or a lost connection), EMHASS Lens catches up the current quarter-hour in live mode: it publishes again, which restores EMHASS's `sensor.p_*`, and sets the EV charger and the inverter for the slot it missed instead of waiting for the next one. It waits for the inverter's entities while Home Assistant is still starting.
- The red problem count in the header links to Health → Problems and lists the problems on hover.
- Kept in sync every minute (live mode): the inverter's passive-mode settings and feed-in limit, and the EV charger's current limit, are set back when something else changed them. Never right after EMHASS Lens's own write, only when the difference is seen twice, and after 3 corrections of the same setting within an hour EMHASS Lens stops for an hour and Health says something else keeps changing it. The Inverter and EV charger pages show *Kept in sync*; both can be turned off in Settings.

## 0.3.9

- EMHASS Lens now fits EMHASS's load model by itself: every night right after the first MPC run from 03:00 (or weekly, or off), and right after the next run when the model can't serve the runs (a short tuned model, changed lags). Only while it drives EMHASS; it never tunes.
- When the live run after a cost-function comparison fails, EMHASS holds the comparison's last plan. EMHASS Lens no longer stores it as "someone else's" plan or publishes it, and Health says what happened.
- The Plan page explains an EMHASS error (EMHASS's message, and whether the plan shown is older) and what "made for someone else" means.
- EV charger: Recent decisions show the new current and the numbers behind each decision (current before, PV, house load, surplus, or the plan's EV power).
- Price sensor check: the App's spot price is rounded like the Home Assistant Nord Pool integration's (3 decimals) before comparing, so rounding no longer shows as differences and a different network package is named again.

## 0.3.8

- A tuned ML load model no longer stops planning. EMHASS's tuner picks its own lag count (6 h to 3 days) and a tuned model forecasts only that far, so runs with a longer horizon failed with "Unable to obtain … lags_opt values". EMHASS Lens now recognises that answer, plans again at once with the horizon cut to what the model covers, and shows a Health warning until the model is fitted again. The Tune button explains this.
- EMHASS is shown as busy, not unreachable, while it computes an action for EMHASS Lens and its health check times out.
- A failed EMHASS action shows its error line instead of EMHASS's whole log.
- Fixed "Task was destroyed but it is pending!" log errors after a browser closed the live log stream.

## 0.3.7

- PV reserved for Excess Solar charging (Settings → EV charger control, off by default): while the car charges from excess solar, the PV forecast sent to EMHASS is reduced by what the charger is expected to take in each slot, until the car's charge to its target is covered, so EMHASS does not plan the home battery or exports with energy the car will use. The Explain table shows the reserved watts per slot; the EV charger page shows the current state.

## 0.3.6

- EV charger page: the charge mode (Manual / EMHASS / Excess Solar) can be switched from the page. The buttons set your Home Assistant helper, the same one the automation reads, and a decision follows at once while the controller is in dry run or live.

## 0.3.5

- Health no longer raises "No successful MPC run recently" the moment you take over: the grace for the first live run now counts from the take-over, not from when the App started.

## 0.3.4

- Settings → Prices → **Compare with your price sensors**: the parity check now also compares the App's import and export prices with your own Nord Pool template sensors (`raw_today` / `raw_tomorrow` / `raw_all`), slot by slot, and explains a constant difference, for example a template still on Elektrilevi Võrk 2 network rates while the App uses Võrk 4. The Health card is now called *Parity checks* and runs with or without the HACS integration.

## 0.3.3

- Settings → Measurements says which unit each sensor is expected in (W, or % for the state of charge) and how to convert a kW sensor.
- Settings: in the review before saving, long field titles wrap instead of running over the change text.

## 0.3.2

- **Storage.** Settings → Storage replaces Settings → Logging → Retention and adds a size budget per database (runs.db 300 MB, app.db 200 MB by default), compaction (VACUUM after cleanup when at least 20 % and 16 MiB of a file are free, or with *Compact now*) and retention for what never expired before: problem history (90 days), market sessions (180 days) and settings versions (newest 100, the current one always). Pinned runs keep their log lines. The nightly cleanup cuts in day-sized steps, checkpoints after deleting, and reports per table.
- Health → **Storage** card: both files with size, data in use, free pages and budget, the biggest tables, the last cleanup, free disk space, the newest Home Assistant backup that contains the App, and *Clean up now* / *Compact now*. New Health warnings: a file over its budget, less than 200 MiB free on the data disk, no recent backup with EMHASS Lens (Settings → Storage → "Warn when no backup for").
- **Backups.** Before a Home Assistant backup the App checkpoints `app.db` and checks its integrity (a damaged file aborts the backup); the add-on now has the Supervisor's `backup` role to list backups. After a restore the App notices the empty `runs.db`, continues run numbers after the ones `app.db` remembers and shows a "Restored from a backup" note. `docs/BACKUP.md` is the runbook; `scripts/restore-drill.sh` rehearses a restore from a backup file without Home Assistant.
- Run details are capped at 512 KiB each (bigger ones are kept as a note with a preview); the cost-function comparison no longer stores each plan twice.
- Shutdown: the UI's live event stream ends by itself when the App stops, so uvicorn no longer waits five seconds and logs a cancelled task on every restart.

## 0.3.1

- After a restart the price forecast is restored from the database together with its last poll time, so it is shown at once, no "forecast isn't available" warning appears, and eupowerprices.com is only asked again when the poll interval is due.
- Start-up no longer records a skipped EMHASS configuration check next to the one already running.
- Settings: long section titles wrap inside the navigation instead of running into the form; "Measurements" lost its parenthetical.
- Qilowatt market control: the *Fusebox sell power helper* is gone. It was a manual export override copied from the automation that nothing ever set; Fusebox sells now follow the commanded power like Kratt sells. Stored settings are migrated (schema 2).

## 0.3.0

- Plan page: the charts now reach back in time. Left of the now line they show what was measured (solid) next to what the plan said at the time (dashed); **History** picks 6 h to 7 days, **Compare with** picks the plan in force or the one made 1, 6 or 24 h earlier. A new **How accurate the plan has been** card gives the error and bias per quantity over 24 h and 7 d, plus the price forecast's error against Nord Pool.
- Settings → **Measurements**: the sensors for grid, battery, PV, house load and SOC, with a sign switch and a scale each. Measured quarter-hour means are read from Home Assistant's recorder every quarter-hour (run *Measurements*) and backfilled after a start or a change (run *Measurement history*); Health warns when a sensor is missing or nothing has been read for an hour.
- Settings → EMHASS → MPC optimization → **Cost function**: ask EMHASS for profit, cost or self-consumption on every run (EMHASS 0.18+; Health warns if EMHASS ignored it).
- Plan page → **Cost functions**: *Compare now* runs the MPC with all three cost functions for the same inputs and shows each plan's net cost, import, export, self-consumption, battery use, end SOC and EMHASS's objective total, one chart overlaying the three plans (each switchable), and the earlier comparisons. **Compare cost functions on every run** does it before every live plan. The method in use always runs last, so EMHASS keeps the real plan.
- `app.db` grows: measurements (kept 120 days by default), per-slot rows of stored plans (14 days) and cost-function plans (30 days).
- Inverter control: the rules now follow the current, template-based version of the automation "EMHASS: Consolidated Inverter Control": ±100 W bands for grid and battery power, "Charge battery and export some to grid" can match, PV export depends on the export price, and the feed-in limit depends only on the export price. Every combination of grid and battery power now maps to a mode. Rule ids are the automation's mode names (`force_charge`, `self_use`, …).
- Settings → Inverter control → Limits: "Block export at or below this price" replaces "Block export below this price" and now defaults to 0.03 €/kWh. An existing install keeps its stored value; set it to the automation's value by hand.
- DOCS: a section on inverter control and how to move the automation over.
- Market session hold (Settings → Market session hold, off by default): while a market automation's session entity (e.g. `input_select.qilowatt_session_state` at `buy`/`sell`) says someone else drives the inverter, MPC runs are built but not sent, the plan isn't published and the inverter isn't touched. When the session ends, EMHASS Lens waits for the inverter enable switch to come back, publishes the stored plan once and decides the inverter from it, writing only what differs. Optionally MPC runs again afterwards without a second inverter write. New `binary_sensor.emhass_lens_hold`, a *Market session hold* row on the Driver card, and the run *Resume after a market session*.
- EV charger control (experimental, Settings → EV charger control, off by default) and an **EV charger** page: EMHASS Lens decides for the charger the way the automation "EV Charging: Combined EMHASS & Excess Solar" does (the target-SoC stop, EMHASS mode following the plan's EV power, Excess Solar mode following the PV surplus). Dry run records each decision with the calls and the phone message it would make and compares with what the automation did; live mode drives the charger and reads it back. Runs: *EV charger decision*, *EV charger comparison*, *EV charger check* (every minute) and *EV target SoC stop*.
- Settings → Notifications → **Mobile notify service**: where phone messages go (e.g. `notify.mobile_app_my_phone`).
- Qilowatt market control (experimental, Settings → Qilowatt market control, off by default) and a **Market** page: EMHASS Lens runs Kratt/Fusebox sessions the way the automation "Qilowatt: Master Market Controller" does, with the same guards against needless inverter writes (hysteresis, deadband, cooldown). Shadow mode decides on every command change and every minute and compares with what the automation did; live mode runs the sessions, keeps the session select and the EMHASS automation switch like the automation, and hands the inverter straight back to the plan when a session ends (one write). Sessions survive a restart; "End session now" is the kill switch.
- One writer for the Sofar passive-mode registers, shared by inverter control and market control: minimal calls, readback, a commit log (the cooldown survives a restart) and a count of apply/feed-in button presses (inverter wear) on the Market page.
- Scheduler: runs started by an event are always recorded; a level-triggered job can queue one rerun instead of being skipped.
- EMHASS 0.18.x support (verified against 0.18.3 and 0.18.5):
  - **P10 PV estimate** (EMHASS 0.18.4): every MPC run also sends Solcast's pessimistic P10 series next to the forecast (`pv_power_forecast_p10`), so EMHASS can plan more conservatively on uncertain days through its `weather_forecast_pv_quantile_bias` setting. On by default (Settings → PV forecast → *Send the P10 estimate too*); only sent to EMHASS 0.18.4 or later and never while the estimate itself is P10. The run's Explain table shows the P10 column, and the Health page's EMHASS card says whether EMHASS actually blends it.
  - **Running now** (EMHASS 0.18.2): Settings → Inputs → Deferrable loads has *Running now when* (an entity, e.g. the charger's state sensor) and *Running states* (e.g. `4`). When set, the run tells EMHASS which loads are already on (`def_current_state`), so it plans them as running instead of scheduling a fresh start.
  - **More than one battery** (EMHASS 0.18.0): the Plan page, the slot tile and the published event read the per-battery `SOC_opt_0`, `SOC_opt_1`, … columns, and the configuration check warns that EMHASS Lens still sends one SOC pair.
  - Configuration check: EMHASS 0.18.5 is now the recommended version (DST-safe MPC horizon and forecasts, `Optimal_Inaccurate` solutions count as ok); a hint about `publish_horizon_attributes` (EMHASS 0.18.2), which can be turned off in EMHASS to keep Home Assistant's recorder small because EMHASS Lens reads the plan from the API.
  - e2e: EMHASS 0.18.5 is the default image; a check for the P10 companion.

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
