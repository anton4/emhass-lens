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
