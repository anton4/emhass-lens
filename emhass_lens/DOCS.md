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

EMHASS Lens can drive an EV charger the way the automation "EV Charging: Combined EMHASS & Excess Solar" does, branch for branch. Your charge-mode helper stays the control:

- **EMHASS**: follow the plan's EV power (`P_deferrable0`): start charging when the car is plugged in and the plan asks for power, adjust the current while charging, pause when the plan asks for none. The current is the planned power ÷ 690 W/A, at least 6 A and at most your maximum current.
- **Excess Solar**: every minute, charge with what the PV leaves over after the house load (the potential PV when the inverter is curtailing), rounded down to whole amps; never raise the current on PV data older than 10 minutes.
- **Manual**: nothing.
- In any mode: when the car's SoC has been at or above the target SoC for 5 minutes, stop charging, set the limit to 0 A, send a phone message and put the target back to 100 %.

Settings → **EV charger control** holds the entities (charger state, current limit, start/stop buttons, car SoC, target SoC, maximum current, PV, house load) and the limits. Settings → **Notifications → Mobile notify service** (e.g. `notify.mobile_app_my_phone`) is where the phone messages go; leave it empty for none.

| Mode | What happens |
|---|---|
| Off | Nothing is scheduled. "Decide now" on the EV charger page still shows what it would do. |
| Dry run | Every decision is recorded with the calls it would make and the message it would send, and a few seconds later the charger is read to see whether the automation did the same. The EV charger page shows the agreement. The charger is never touched. |
| Live | EMHASS Lens presses start/stop, sets the current limit and the target SoC, sends the message and reads the charger back. |

**Moving the automation over:** run **Dry run** for about a week with the automation still on and watch the agreement. Then set the automation's entity under Charger entities → *Home Assistant automation (interlock)*, turn the automation off and switch to **Live**: EMHASS Lens refuses to act while that automation is on, so the two never both drive the charger. To go back, set the mode to Off and turn the automation on again.

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

## Data and backups

- **`app.db`** holds settings, their history, prices and forecasts. It is part of Home Assistant backups.
- **`runs.db`** holds run details and logs. It is excluded from backups and pruned by the retention settings (Settings → Logging → Retention).
