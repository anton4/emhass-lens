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
| Import price now / Export price now | €/kWh for the current 15-minute slot, with the next slot and the price period as attributes |
| Problem | On while something needs attention (the attributes list what) |
| Last successful MPC | Timestamp of the last live run that produced a plan |
| Auto MPC | Switch: pause or resume the scheduled MPC runs, e.g. from an automation during an mFRR session |
| Run MPC now | Button |

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
