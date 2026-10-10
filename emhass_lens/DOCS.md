# EMHASS Lens

EMHASS Lens drives [EMHASS](https://github.com/davidusb-geek/emhass), and you can watch everything it does:

- **Inputs:** it builds the price, PV and battery inputs.
- **Scheduling:** it runs the MPC optimization every quarter-hour.
- **Publishing:** it publishes the plan as each slot starts.
- **Records:** it keeps every run, payload, EMHASS response and log line.

## Getting started

1. Start the App and open **EMHASS Lens** from the sidebar.
2. Go to **Settings** and work through the sections:
   - **EMHASS**: the address of your EMHASS App. Leave it empty to look it up automatically. The mode starts as **Off**.
   - **Inputs**: the entities for battery state of charge, the target SOC and your deferrable loads (e.g. EV charging).
   - **Prices**: your Elektrilevi network package and the other fees.
   - **Price forecast** and **PV forecast**.
3. Switch the EMHASS mode to **Dry run** to see the payloads EMHASS Lens would send, without sending them.
4. When the dry runs look right, switch to **Live**.

## Modes

| Mode | What happens |
|---|---|
| Off | Prices and forecasts are kept up to date; EMHASS is never called. |
| Dry run | Every quarter-hour the MPC payload is built and validated and shown under **Runs**, but not sent. |
| Live | The payload is sent to EMHASS, the plan is read back and published at the start of each slot. |

## Moving over from the HACS integration

While the [HACS integration](https://github.com/anton4/homeassistant-ee-nordpool) still runs, EMHASS Lens works next to it:

1. **Import the settings.** Health → *Import from the HACS integration* copies its tariffs, API key and forecast choices into a new settings revision.
2. **Shadow mode (mode Off).** Every quarter-hour EMHASS Lens builds the MPC payload it would send. The *parity* check compares prices, PV and payloads with the integration's entities and labels the differences that are intended, for example the corrected EV deadline.
3. **Dry run.** EMHASS Lens also runs every check a live run would, such as whether EMHASS is reachable, whether its configuration is compatible, and whether nobody else is driving EMHASS.
4. **Take over** (Health page). This turns the integration's *EMHASS Auto MPC* switch off and switches EMHASS Lens to live with Auto MPC on, in one step. **Hand back** does the reverse.

EMHASS Lens refuses to run live while the integration's Auto MPC switch is on, so two planners never drive EMHASS at once.

## Home Assistant entities (MQTT)

With **Settings → Home Assistant outputs → MQTT entities** on, EMHASS Lens publishes an *EMHASS Lens* device through the Mosquitto broker App:

| Entity | What |
|---|---|
| `sensor.emhass_lens_import_price` | Import price now, €/kWh for the current 15-minute slot. Attributes: next slot price, period (day/night/peak), spot. |
| `sensor.emhass_lens_export_price` | Export price now, €/kWh |
| `binary_sensor.emhass_lens_problem` | On while something needs attention. The attributes list what. |
| `binary_sensor.emhass_lens_hold` | On while a market session holds the inverter (see *During a market session*). Attributes: the entity, its value, since when, the last resume. |
| `sensor.emhass_lens_last_mpc` | When the last live run produced a plan |
| `switch.emhass_lens_auto_mpc` | Pause or resume the scheduled MPC runs, e.g. from an automation during an mFRR session |
| `button.emhass_lens_run_mpc` | Run MPC now |

The entities are retained on the broker, so they survive Home Assistant restarts.

## The plan-published event

In live mode EMHASS Lens publishes the plan right after each slot starts. It calls EMHASS's `publish-data`, then fires `emhass_lens_plan_published` with the current slot's values:

```yaml
event_type: emhass_lens_plan_published
data:
  slot_start: "2026-10-09T11:15:00.000+00:00"
  current: {p_batt_w: -11143, p_grid_w: 0, p_pv_w: 12928, p_pv_curtailment_w: 0, soc_opt: 0.496}
  price: {import: 0.1672, export: 0.0351}
```

An inverter-control automation can trigger on this event instead of on a fixed second after the quarter-hour. Keep the old time trigger as a fallback. If your automation only writes changed values, the second run is a no-op:

```yaml
triggers:
  - trigger: event
    event_type: emhass_lens_plan_published
  - trigger: time_pattern   # fallback if the event doesn't come
    minutes: "/15"
    seconds: 30
mode: queued
```

## Prices and your own price sensors

EMHASS Lens fetches Nord Pool's day-ahead prices itself and prices every quarter-hour with the fees, Elektrilevi network package, night hours, holidays and VAT under **Settings → Prices → Tariff**; the Inputs page shows the breakdown per slot. It does not read Home Assistant price sensors. If you keep Nord Pool template sensors with fees for dashboards or automations, **Settings → Prices → Compare with your price sensors** names them (a sensor with a `raw_today` / `raw_tomorrow` or `raw_all` attribute of `{start, end, value}` in €/kWh including VAT), and the parity check (every quarter-hour at :05, Health → Parity checks) compares them with the App's prices slot by slot. A difference that is the same for every day slot and every night slot is explained in words, for example a template still on Elektrilevi Võrk 2 rates while the contract is Võrk 4. The Home Assistant Nord Pool integration rounds the spot price to 3 decimals (the `3` in `sensor.nordpool_kwh_ee_eur_3_10_0`), up to 0.05 c/kWh; the comparison rounds the App's spot price the same way, so only real differences show (Settings → Prices → Compare with your price sensors → *Spot price decimals*).

The Plan page says why when EMHASS's last run didn't end "ok" (EMHASS's own error message, and whether the plan shown is older than that run), and explains a plan *made for someone else*: EMHASS Lens didn't send the request that made it (EMHASS's web UI, an automation or script, or the HACS integration).

## Plan history and accuracy

The Plan page's charts reach back in time as well as forward. Left of the now line they show what was measured (solid) next to what the plan said at the time (dashed); right of it, the current plan. **History** picks how far back (6 h to 7 days) and **Compare with** which earlier plan a past slot is held against: *Plan in force* is the plan that was current when the slot came (what the inverter followed), *1 h / 6 h / 24 h ahead* the plan made that long before it, which shows how good the forecasts were at a distance.

Measured values come from Home Assistant's recorder. **Settings → Measurements** names the sensors for grid power, battery power, PV power, house load and battery SOC; leave one empty to skip it. Signs follow EMHASS: grid positive when importing, battery positive when discharging. If a sensor counts the other way round, tick **Opposite sign**; **Multiply by** turns kW into W or a percentage SOC into 0–1. The House load sensor should be the load *without* deferrable loads (what EMHASS forecasts as `P_Load`), usually the same sensor EMHASS learns from.

Every quarter-hour the run *Measurements* reads the slot that just ended and stores its time-weighted mean per quantity. After a start, and after a change under Settings → Measurements, *Measurement history* reads older history in six-hour chunks (newest first) back to **Read history back** days, the recorder's reach (10 days by default in Home Assistant). Measurements are kept for **Keep measurements** days in `app.db`.

**How accurate the plan has been** (under the charts) gives, per quantity, the mean absolute error and the bias (plan minus measurement; plus means the plan expected more) over the last 24 hours and 7 days, the load error also as a share of the measured load, and the price forecast's error against Nord Pool's price for the forecast fetched 24 hours before each slot. When grid or battery power moves against the plan most of the time, the card says so: that nearly always means the sensor's sign is the reverse of EMHASS's.

## Cost functions

EMHASS can optimise for one of three things, its `costfun`: **profit** (import cost minus export revenue, EMHASS's usual default), **cost** (import cost only, exports earn nothing) or **self-consumption** (use as much PV on site as possible). **Settings → EMHASS → MPC optimization → Cost function** picks the one every live run asks for; *EMHASS's own setting* sends nothing and leaves EMHASS's configured value in charge. The cost function is a runtime parameter since EMHASS 0.18; the plan read back shows which one EMHASS used, and Health warns if it was ignored.

**Cost functions** on the Plan page compares the three. **Compare now** runs the MPC three times with the same inputs, once per method, and shows what each would do with the battery and the grid and what it would cost over the plan's horizon: net cost, import and export, self-consumption, battery throughput, end SOC, and EMHASS's own objective total (the sum of the plan's `cost_fun_*` column, in EMHASS's sign, only comparable within one method). One chart overlays the three plans for a chosen quantity, with each method switchable on and off; a table below lists earlier comparisons. **Compare cost functions on every run** does the same before every live plan.

Every optimisation replaces EMHASS's latest plan, which publish-data and the plan API read, so the method in use always runs last and EMHASS ends with the real plan; the plan watch and publishing wait while a comparison runs. A comparison is refused while the mode is Off, EMHASS is unreachable, the HACS integration still drives EMHASS, an ML fit runs or a market session holds the inverter. Two extra optimisations take a few seconds to a minute each; if publishing gets tight, move the MPC time earlier under Settings → EMHASS → MPC optimization.

**When the live run after a comparison fails**, EMHASS is left holding the last alternative's plan: EMHASS's plan API keeps the last successful plan, and `publish-data` publishes the latest result. EMHASS Lens notices it, doesn't store or publish that plan, and Health shows *EMHASS holds a cost-function comparison plan* until a live run succeeds; meanwhile the inverter keeps the last live plan until it is too old.

## Inverter control (experimental)

EMHASS Lens can set a Sofar inverter's passive mode from the plan itself, instead of a Home Assistant automation doing it. It mirrors the automation "EMHASS: Consolidated Inverter Control" rule for rule: the plan's grid power picks the branch (importing, exporting or neutral), the battery power picks the mode (force charge, force discharge, use only grid, self-use, …), and when exporting with an idle battery the export price decides whether the PV is exported or kept. The feed-in limit is 0 W whenever the export price is at or below **Settings → Inverter control → Limits → Block export at or below this price**, otherwise the export maximum.

| Mode | What happens |
|---|---|
| Off | Nothing is decided. |
| Dry run | Right after each publish the decision is recorded (rule, why, targets) and 40 s later the inverter entities are read and compared with it. The **Inverter** page shows the agreement over 24 h and 7 days. The inverter is never touched. |
| Live | EMHASS Lens applies the decision itself (the passive-state select, the three passive-mode numbers and their apply button, the feed-in limit and its button) and reads them back. Only values that differ are written. |

Nothing is written while the inverter isn't in passive mode, while the automation switch (`input_boolean.emhass_automation`) is off, for example during an mFRR session, or when the plan is stale.

**Moving the automation over:** set the thresholds under Limits to the automation's values, run **Dry run** for about a week and watch the agreement. When it stays at 99 % or more, turn the Home Assistant automation off (keep it) and switch to **Live**. To go back, set the mode to Off and turn the automation on again.

## During a market session (mFRR)

When an aggregator such as Qilowatt takes the inverter for a Kratt or Fusebox activation, EMHASS Lens can stand back and take over again the moment the session ends. Turn it on under **Settings → Market session hold**:

- **Session entity** and **busy values**: the entity your market automation maintains, for example `input_select.qilowatt_session_state` with the values `buy` and `sell`.
- While the entity shows a busy value, MPC runs are built but not sent, the plan isn't published and the inverter isn't touched. The Health page's *Driving EMHASS* card and `binary_sensor.emhass_lens_hold` show the hold.
- When the session ends, EMHASS Lens waits for the inverter control's enable switch to come back on (your automation hands it back), then publishes the stored plan once and decides the inverter from it. Only the registers that differ are written, so a session end costs at most one write to the inverter.
- **Re-run MPC after a session** (off by default) also runs MPC again with the battery state after the session and publishes that plan. The inverter keeps this slot's targets and follows the new plan from the next slot, so there is still only one inverter write.

Each resume is recorded as a run of *Resume after a market session*.

## EV charger control (experimental)

EMHASS Lens can drive an EV charger the way the automation "EV Charging: Combined EMHASS & Excess Solar" does, branch for branch. Your charge-mode helper stays the control, and the EV charger page can switch it (the buttons set the helper through Home Assistant, so the automation sees the same mode):

- **EMHASS**: follow the plan's EV power (`P_deferrable0`): start charging when the car is plugged in and the plan asks for power, adjust the current while charging, pause when the plan asks for none. The current is the planned power ÷ 690 W/A, at least 6 A and at most your maximum current.
- **Excess Solar**: every minute, charge with what the PV leaves over after the house load (the potential PV when the inverter is curtailing), rounded down to whole amps; never raise the current on PV data older than 10 minutes.
- **Manual**: nothing.

Each decision under **Recent decisions** shows what it does (for example *→ limit 12 A*) and the numbers it was made from: the current before, and the PV, house load (with the charger's share) and surplus for Excess Solar, the plan's EV power for EMHASS mode, or the car's level and target for the SoC stop.
- In any mode: when the car's SoC has been at or above the target SoC for 5 minutes, stop charging, set the limit to 0 A, send a phone message and put the target back to 100 %.

Settings → **EV charger control** holds the entities (charger state, current limit, start/stop buttons, car SoC, target SoC, maximum current, PV, house load) and the limits. Settings → **Notifications → Mobile notify service** (e.g. `notify.mobile_app_my_phone`) is where the phone messages go; leave it empty for none.

| Mode | What happens |
|---|---|
| Off | Nothing is scheduled. "Decide now" on the EV charger page still shows what it would do. |
| Dry run | Every decision is recorded with the calls it would make and the message it would send, and a few seconds later the charger is read to see whether the automation did the same. The EV charger page shows the agreement. The charger is never touched. |
| Live | EMHASS Lens presses start/stop, sets the current limit and the target SoC, sends the message and reads the charger back. |

**Moving the automation over:** run **Dry run** for about a week with the automation still on and watch the agreement. Then set the automation's entity under Charger entities → *Home Assistant automation (interlock)*, turn the automation off and switch to **Live**: EMHASS Lens refuses to act while that automation is on, so the two never both drive the charger. To go back, set the mode to Off and turn the automation on again.

### Reserving PV for Excess Solar

In Excess Solar mode the car takes the PV surplus outside EMHASS's plan, and EMHASS, which still sees the full PV forecast, may plan to fill the home battery or export with energy the car will use. EMHASS has no input for that, so **Settings → EV charger control → PV reserved for Excess Solar** lets EMHASS Lens send it a smaller PV forecast instead. While the charge mode is Excess Solar, the car is plugged in and its SoC is below the target, every slot's PV forecast is reduced by what the charger is expected to take: the Excess Solar rule applied to the PV forecast minus the house load EMHASS itself forecasts for that slot (the `P_Load` of the newest plan), in whole amps, at least 6 A and at most the maximum current. Reserving stops once the energy from the car's level to its target is covered, which needs the **car battery capacity** setting; the rest of the horizon gets the full PV again. The Explain table of each run (and of the payload preview) shows the reserved watts per slot and a line saying how much was reserved and until when, and the EV charger page shows the current state. Nothing changes in EMHASS or Manual mode, in the parity check against the HACS integration, or when the controller is Off (the car's entities are still read). Because EMHASS plans with the smaller forecast, its plan's `P_PV` and the PV accuracy on the Plan page show the PV that was left for it, not the full forecast.

## Qilowatt market control (experimental)

Kratt and Fusebox activations (mFRR, aFRR) arrive through Qilowatt as three sensors: the source (`sensor.qw_source`), the command (`sensor.qw_mode`) and the power limit (`sensor.qw_powerlimit`). EMHASS Lens can run these sessions on the inverter the way the automation "Qilowatt: Master Market Controller" does: on every command change (after a short settle time), every minute and at start-up it derives the wanted inverter state from the current values and reconciles it with the registers, with three guards against needless writes to the inverter's EEPROM (a direction-aware hysteresis, a proportional deadband and a cooldown; a session end is never throttled). The **Market** page explains the guards with your thresholds and shows the live command, the session, each decision with its reasoning, and how many times the inverter's apply and feed-in buttons were pressed.

| Mode | What happens |
|---|---|
| Off | Nothing is watched. "Reconcile now" still shows what it would do. |
| Shadow | Every decision is recorded, and a few seconds later the session select, the EMHASS automation switch and the inverter registers are read to see whether the automation did the same. The App's session follows the automation's select. Nothing is written. |
| Live | The App runs the sessions: it keeps `input_select.qilowatt_session_state` and `input_boolean.emhass_automation` like the automation does, writes feed-in first and the passive-mode registers after, and when a session ends it hands the inverter straight back to the plan with one write (the automation's safe state only when no fresh plan exists). Sessions are stored, so a restart continues or ends them from the current sensors. "End session now" on the Market page is the kill switch. |

Settings → **Qilowatt market control** holds the entities and thresholds (the automation's values are the defaults). The Sofar registers and buttons come from Settings → Inverter control.

**Moving the automation over:** 1) inverter control must be live, so that the plan can be re-applied after a session. 2) Run **Shadow** for at least a week with real sessions and watch the agreement on the Market page; 99 % or more is the bar. 3) With no session open, turn the Home Assistant automation off (keep it; set it under Market entities → *Home Assistant automation (interlock)*) and switch to **Live**; watch the first session. Going back: set the mode to Off and turn the automation on again. Because the App mirrored the session select and the switch, the automation carries on from where things are.

What stays as it was: the automation wrote feed-in only while selling, and a command under the gate during a session ends the session rather than flipping it. What is different on purpose: a session end goes straight to the plan's targets instead of the automation's "self-use, grid 0" defaults, and a burst of three sensor updates becomes one decision.

## The ML load forecast

EMHASS forecasts the house load with a model trained on your load sensor (`load_forecast_method: mlforecaster`). The Health page's **ML load forecast** card runs **Fit**, **Tune** and **Predict**; Fit uses the same number of lags the MPC runs send, so the model forecasts the whole horizon.

**Tune** is different: EMHASS's tuner picks its own lag count from 6 h, 12 h, 1 day, 1.5 days, 2 days, 2.5 days or 3 days, and a tuned model forecasts only that far. Once tomorrow's prices and a forecast day are in, the horizon is about 2.5 days, so a model tuned to 1.5 days (144 slots) makes every run fail with "Unable to obtain 233 lags_opt values". EMHASS Lens recognises that answer, remembers how far the model reaches and plans again at once with the horizon cut to it; later runs are cut straight away. Health shows *EMHASS's load model forecasts only N slots* meanwhile. **Fit** restores the full horizon; after a day EMHASS Lens tries the full horizon again by itself, in case the model was fitted elsewhere.

**Automatic fit.** Settings → EMHASS → ML load forecast → *Fit the model automatically* (every night by default) fits the model right after the first MPC run from 03:00, so it keeps up with the house; *Fit right away when the model can't serve the runs* fits after the next run when the model is a short tuned one or the lag count changed (at most every 6 hours). Both only while EMHASS Lens drives EMHASS (live with Auto MPC); in dry run EMHASS is never touched. It never tunes. MPC runs are refused while EMHASS fits, so a slow fit costs at most one quarter's run. The Fit job on the Health page marks automatic fits.

While EMHASS computes something for EMHASS Lens (an MPC solve, a fit or a tune), it may not answer its health check in time. The Health page's EMHASS card then shows *Busy with …* instead of calling EMHASS unreachable; a refused connection still counts as unreachable.

## EMHASS versions

EMHASS Lens needs EMHASS **0.17.9** or later (the plan API). With **0.18.2** or later it no longer has to wait out the seconds around a slot boundary. **0.18.5** is recommended: the MPC horizon and the forecasts stay right across the DST changes, and a solution EMHASS calls `Optimal_Inaccurate` counts as a plan instead of an error. The Health page's EMHASS card shows the version and the configuration checks.

What EMHASS Lens uses from the 0.18 releases:

- **P10 PV estimate (0.18.4).** Solcast's pessimistic P10 series goes along with the forecast on every run. EMHASS blends the two by its `weather_forecast_pv_quantile_bias` setting: 0 (its default) ignores P10, 0.3 moves the forecast 30 % of the way toward P10, 1 plans on P10 alone. Settings → **PV forecast → Send the P10 estimate too** turns it off; it is never sent while the estimate itself is P10. The EMHASS card says whether the two sides agree, and each run's Explain table shows the P10 column.
- **Running now (0.18.2).** Settings → **Inputs → Deferrable loads → Running now when** names an entity that says the load is running right now, with **Running states** listing the states that mean running, for example the ABB charger's `sensor.abb_terra_ac_charger_charging_state_raw` with `4`. EMHASS then plans a load that is on as on, instead of scheduling a fresh start with its startup penalty. Nothing is sent while the field is empty.
- **More than one battery (0.18.0).** EMHASS with `number_of_batteries` above 1 publishes `SOC_opt_0`, `SOC_opt_1`, … instead of `SOC_opt`; the Plan page, the slot tile and the plan-published event read them. EMHASS Lens still sends one battery SOC pair, which EMHASS applies to every battery, so the configuration check warns.
- **Horizon attributes (0.18.2).** EMHASS attaches the whole horizon to every sensor it publishes. EMHASS Lens reads the plan from the API and doesn't need that; the configuration check hints that `publish_horizon_attributes` can be turned off in EMHASS to keep Home Assistant's recorder small, unless a dashboard uses the attributes.

EMHASS-side features that work without any change here: capacity charges, thermal loads and the heat topology, VictoriaMetrics and InfluxDB history, the hybrid-inverter efficiency curves, the tariff schedule time zone and `battery_soc_final_reward_factor`. Set them in EMHASS; EMHASS Lens's runtime parameters don't touch them.

## App options (Configuration tab)

| Option | Meaning |
|---|---|
| `log_level` | Starting log level. **Settings → Logging** can change it live, also per component. |
| `safe_mode` | Starts with all scheduled jobs stopped and EMHASS mode forced off. Use it if a settings change made the App misbehave. |

All other settings live in the App: every save is kept as a revision, with who changed what and when, and any revision can be restored.

## Logs and runs

- **Logs** shows the App's log live. Every line belongs to a component, and lines written during a job carry that run's number.
- **Runs** lists every job execution with its outcome. Open one to see its inputs, the request it sent, the response it got and its log lines. You can also download it all as one JSON file for a bug report.
- The same log lines appear in the App's **Log** tab in Home Assistant.

## Security

- **Changes need the Home Assistant login.** Settings can only be changed through the sidebar (Ingress).
- **The direct port is off by default.** If you enable it (`8099/tcp`), it has no login and is read-only, with secrets masked.

## Data, storage and backups

EMHASS Lens keeps two SQLite files in its `/data` folder.

- **`app.db`** holds the settings and their history, Nord Pool prices, price forecasts, every EMHASS plan, the measured history, the cost-function comparisons and a few remembered facts. It is part of every Home Assistant backup. Right before a backup the App checkpoints the file and runs an integrity check (`backup_pre`), so the copy is complete and a damaged file stops the backup instead of being saved.
- **`runs.db`** holds run details, their inputs and responses, and the log. It is bulky, rebuilt over time, and left out of backups.

**Retention** (Settings → Storage → Retention) says how long things stay: logs and run details 7 days, run summaries 30 days, problem history 90 days, market sessions 180 days, and the newest 100 settings versions (older ones go only after 30 days; the current one always stays). Prices stay 120 days, forecasts and cost-function plans 30, measurements as set under Measurements, plans the newest 2000. Pinned runs keep their details and log lines for ever.

**Size budgets** (Settings → Storage) cap each file: `runs.db` 300 MB and `app.db` 200 MB by default. When the data in a file exceeds its budget, the nightly cleanup (03:30) cuts the oldest calendar day of one table at a time, in a fixed order: for `runs.db` log lines, then run details, then run summaries; for `app.db` cost-function plans, plans, measurements, forecasts, prices, inverter write records, problem history, market sessions and finally settings history. It never cuts pinned runs, open problems or sessions, the current settings version, or the last one to seven days each table needs for the planner and the accuracy card. When even that leaves a file over budget, Health says so.

**Compaction.** Deleting rows frees pages inside the file; SQLite reuses them, so the file stops growing, but it only shrinks with `VACUUM`. After each cleanup the App compacts a file that has at least 20 % and 16 MiB of free pages, provided the disk has free space of about twice the file (set Settings → Storage → Compact databases to "Only with Compact now" to stop that). Compaction pauses the App for seconds to tens of seconds.

The Health page's **Storage** card shows both files (size, data in use, free pages, budget), the biggest tables, the last cleanup, the free disk space and the newest Home Assistant backup that contains the App, with **Clean up now** and **Compact now**. Health warns when no backup containing EMHASS Lens is newer than Settings → Storage → "Warn when no backup for" (3 days by default), when a file stays over budget, and when the data disk has less than 200 MiB free.

**Restoring.** A restored Home Assistant brings `app.db` back with everything above, secrets included. Run history starts afresh: the App notices an empty `runs.db` next to an `app.db` that remembers run numbers, keeps one placeholder run so new numbers continue after the old ones, and shows a "Restored from a backup" note on the Storage card until dismissed. The agreement figures (inverter, EV charger, market) and the measured history start from scratch. The step-by-step runbook, including a rehearsal that restores a backup into a scratch copy without touching Home Assistant, is in the repository's `docs/BACKUP.md`.
