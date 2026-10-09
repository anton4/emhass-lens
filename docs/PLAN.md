<!-- Approved plan, copied from the planning session on 2026-10-09. Progress is tracked in docs/STATUS.md. -->
# Plan: EMHASS Lens, a Home Assistant App that replaces the `homeassistant-ee-nordpool` HACS integration

## Context

The HACS integration (`custom_components/homeassistant-ee-nordpool`, domain `nordpool_ee_scraper`, about 1,600 lines of code) does five things: it fetches Nord Pool EE prices, fetches EE/FI price forecasts, applies Estonian tariffs, reshapes the Solcast PV forecast, and runs EMHASS MPC. It grew by trial and error, and it uses HA entities as its UI, its settings store, its debug console and its data bus. That causes these problems:

- **Too many entities.** It has more than 20 entities. Many carry huge list attributes that exceed the recorder's 16 KB limit, and many states are strings like "N calculated". The MPC code reads its own prices back through HA state.
- **Settings in three places:** the config flow, the number/select/switch entities, and a hidden `.storage` cache. Changing any setting forces a full Nord Pool refetch.
- **Four interlocking timing hacks:** a phase lock to :13, a ±30 s hazard guard, an anchor trim and a :xx:02 publish. They all sit on a one-minute coordinator tick.
- **Hard-coded values:** the EMHASS URL, every input entity and the EV parameters.
- **Poor debuggability:** debugging means reading entity attributes, and logs exist only in HA's log.

The exploration also found real bugs (section 9). The most important ones:

- The EV deadline is one slot off on every scheduled run.
- An unavailable SOC entity makes MPC silently not run, and nothing is recorded.
- A failed forecast fetch is retried every minute.
- The Solcast reshaping shifts all later days when a day is missing or on DST days.

**Goal: EMHASS Lens**, a standalone Home Assistant App with an Ingress web UI that is the front end for EMHASS.

- **Inputs:** it feeds EMHASS prices, forecasts and the SOC/EV inputs.
- **Runs:** it decides when EMHASS runs.
- **Results:** it shows what EMHASS planned and why.
- **Pluggable sources:** Nord Pool EE prices, Estonian tariffs, the EE/FI forecasts and Solcast are input sources, not the core.
- **Settings:** everything is configured in the UI and applied immediately, without a restart.
- **Transparency:** every fetch, calculation and EMHASS call can be inspected (inputs, what was sent, what came back, why). Logs stream live in the UI.

### Decisions taken
| Topic | Decision |
|---|---|
| Identity | **EMHASS Lens**. Repo `anton4/emhass-lens`, local `~/Documents/bla/emhass-lens`. App slug and folder `emhass_lens`. Python package `emhass_lens`. Image `ghcr.io/anton4/emhass-lens-{arch}`. Sidebar title "EMHASS Lens". Described as "a companion App for EMHASS". |
| Packaging reference | `/Users/jorma/Documents/bla/MFFR-Profit-Tracker`: `repository.yaml` plus the App folder, a multi-stage Dockerfile at the repo root, FastAPI with React/Vite, and ghcr images per architecture built on native runners. |
| EMHASS | Stays its own App. EMHASS Lens drives it over REST. |
| Settings | Owned by the App: validated, applied live, with a browsable change history. HA options hold only bootstrap values. |
| HA entities | MQTT discovery: one device, 6 small entities. Uses the Mosquitto broker App. |
| Inverter automation | Stays in HA. The App fires an event after each publish. Moving inverter control into the App is an optional last phase. |
| EV charger automation | Moved into the App as Phase 6 with all three branches (target-SoC stop, EMHASS mode, Excess Solar), so the charger has one writer. The HA helpers (charge mode, target SoC, maximum current) stay the owner's controls. Dry run with agreement first. |
| Market sessions (mFRR) | The App holds MPC sends, publishes and inverter writes while the market automation's session select is busy, and re-applies the plan with at most one inverter write when it ends (Phase 5c). Moving the market controller itself into the App is Phase 7, after Phase 5 is live; a session end then goes straight to the plan's targets. |
| Old repo | `homeassistant-ee-nordpool` stays untouched while both run side by side. Then it gets a deprecation release and is archived. |

---

## 1. Shape of the system

```
 HA (states, WS events)          EMHASS Lens App                            EMHASS App
 ───────────────────────   ┌───────────────────────────────────────┐   ─────────────────────
 Solcast day sensors  ───► │ Inputs: prices (Nord Pool EE + tariff │   POST /action/naive-mpc-optim
 nordpool_predict_fi  ───► │   engine), forecasts (EE API / FI),   │──►POST /action/publish-data
 SOC / target SOC     ───► │   PV (Solcast), SOC, deferrable loads │   GET /api/v1/plan, /last-run,
 EV helpers           ───► │ → MPC builder (timestamped, validated)│◄──  /healthz, /get-config
                           │ → scheduler (quarter-hour, locked)    │
 MQTT entities (6)    ◄─── │ → runs + artifacts + logs (SQLite)    │
 event emhass_lens_   ◄─── │ → UI: Plan · Inputs · Runs · Logs ·   │
   plan_published          │       Health · Settings (Ingress)     │
 inverter automation ◄─────┘                                       │
```

- The MPC payload is built from the App's own timestamped data, never read back from HA entities.
- Lists become positional only at the EMHASS boundary.

## 2. Repo layout and packaging (new repo `emhass-lens`)

```
repository.yaml                         # copy of MFFR's, with the new name/url
emhass_lens/  config.yaml DOCS.md README.md CHANGELOG.md translations/en.yaml icon.png logo.png
Dockerfile .dockerignore                # MFFR multi-stage (node build UI → python:3.14-slim), CMD python -m emhass_lens
backend/   pyproject.toml uv.lock  emhass_lens/…  tests/…
frontend/  (TypeScript) package.json vite.config.ts src/…
scripts/make-local-addon.sh            # MFFR script with paths adapted
docker-compose.yml .env.example        # standalone dev against a real HA (HA_URL + long-lived token)
.github/workflows/ci.yml, addon-image.yml   # the image job needs CI to pass
```

**Rule:** no other file in the repo may be named `config.yaml` or `config.json`, because the Supervisor scans the repo for App configs. Fixture files get descriptive names, such as `emhass_get_config.json`.

`emhass_lens/config.yaml`, the key parts:
```yaml
slug: emhass_lens
version: "0.1.0"
stage: experimental                    # until Phase 2 exit
arch: [amd64, aarch64]
image: ghcr.io/anton4/emhass-lens-{arch}
startup: application
boot: auto
init: true
ingress: true
ingress_port: 8099
panel_icon: mdi:chart-timeline-variant-shimmer
panel_title: EMHASS Lens
homeassistant_api: true                # REST + WebSocket via http://supervisor/core
hassio_api: true                       # /addons lookup to find the EMHASS hostname
services: ["mqtt:want"]                # broker credentials from /services/mqtt; App still runs without it (problem shown)
watchdog: "http://[HOST]:[PORT:8099]/api/health/live"
backup: hot
backup_exclude: ["runs.db*"]           # bulky run artifacts and logs stay out of HA backups
ports: {8099/tcp: null}                # direct port off by default
options: {log_level: info, safe_mode: false}
schema: {log_level: "list(debug|info|warning|error)", safe_mode: bool}
```

- **Bootstrap options:** `log_level` and `safe_mode` only.
- **What `safe_mode` does:** starts the App with all jobs paused and EMHASS mode forced to `off`.
- **Why it exists:** it's the escape hatch, reachable from HA's Configuration tab, if the settings or the UI are broken.
- **Everything else lives in App settings.**

## 3. Backend (Python 3.14, FastAPI, asyncio, pydantic v2, httpx, aiomqtt, uv)

```
emhass_lens/
  core/      clock.py (Clock + FakeClock) slots.py bus.py redact.py
  settings/  model.py store.py migrations.py legacy_import.py
  db/        conn.py migrate.py sql/{app,runs}/000N_*.sql
  logs/      setup.py context.py ring.py sink_sqlite.py
  scheduler/ core.py triggers.py registry.py
  clients/   supervisor.py ha_rest.py ha_ws.py emhass.py nordpool.py eupowerprices.py mqtt.py
  domain/    (pure functions) nordpool.py poll_policy.py forecast/{base,ee_eupowerprices,fi_ha_entity,stitch}.py
             tariffs/{packages,holidays,engine}.py pv_solcast.py mpc/{inputs,anchor,payload,validate}.py
             emhass_checks.py health_rules.py parity.py
  services/  prices forecasts pv mpc publish ml health parity runs outputs
  api/       security.py static.py routes/{meta,plan,inputs,runs,logs,events,settings,health,jobs,actions}.py
```

### 3.1 Wiring
- `python -m emhass_lens` does three things:
  1. Reads `/data/options.json` into a frozen `BootstrapOptions`.
  2. Sets up logging.
  3. Calls `uvicorn.run(create_app(boot))`.
- There are no module globals and no environment reads at import time. This is the main thing done differently from MFFR's `start.py`.
- `container.py` wires the services explicitly, and routes reach them through `app.state`.
- **Startup order (lifespan):** logging → DB migrations → settings → event bus → HTTP clients → HA WebSocket (background, with retry) → EMHASS probe → MQTT → scheduler. The scheduler is skipped if `safe_mode` is on or the settings are invalid.

### 3.2 Settings (owned by the App, applied live, with history)
- **One `Settings` model** with `extra="forbid"`.
- **UI metadata lives in the schema** (`json_schema_extra.ui`: group, unit, widget such as entity/secret/duration, advanced flag), so the UI renders forms from the schema.
- **Secrets** are `SecretStr`.
- **Cross-field validators** catch inconsistent combinations, for example the EE forecast source without an API key.

| Section | Contents |
|---|---|
| `emhass` | `base_url`, which is auto-discovered (Supervisor `/addons` → `http://<hostname>:5000`, falling back to host `172.30.32.1:<port>`) with a "Test" button. `mode: off \| dry_run \| live`. Per-action timeouts. `mpc{auto, slot_offset "13:00", min/max horizon}`. `publish{enabled, slot_offset "00:02"}`. `ml{var_model, sklearn_model, historic_days, num_lags: auto\|int}`. `extra_runtime_params`, an advanced pass-through that is shown in Explain. |
| `inputs` | `soc_init{entity, ÷100, on_unavailable: refuse\|default}`, `soc_final{…}`, and a `deferrable_loads[]` list. Each load has `{name, enabled_entity, nominal_power_w, operating_hours_entity, deadline entity, single_constant_entity}`. The defaults come from the current hard-coded EV entities. |
| `prices` | Nord Pool area EE, poll windows (13:45 / fast 5 min until 15:00 / slow 60 min), and tariff: `package: vork1\|vork2\|vork4\|vork5\|custom`, margin, taastuv, aktsiis, tasakaal, varustus, VAT, network day/night/peaks, night window and clock basis, export margin and tasakaal. Stored in €/kWh; the UI can show cents. |
| `forecast` | `source: none \| ee_eupowerprices \| fi_ha_entity`, `extend_days` 1–7, EE `{api_key, poll_hours}`, FI `{entity, unit, vat_included_pct}` |
| `pv` | Solcast entity prefix, days, field (`from_select` or a fixed value), scale |
| `outputs` | MQTT on/off, entity prefix, `fire_event` |
| `health`, `notifications`, `logging` | Health thresholds; persistent notifications on/off; per-component log levels; retention |
| `parity` | Legacy entity ids and tolerances. Only used during Phases 1–2. |

- **Store:** a `settings_revision` table holds id, time, actor (taken from the Ingress `X-Remote-User-*` headers), source (`ui`, `import`, `migration`, `revert` or `legacy_import`), schema version, the full document, the diff and a comment. The current settings are the latest revision.
- **API:**

| Endpoint | Purpose |
|---|---|
| `GET /api/settings` and `/schema` | Read the settings and the schema the UI builds forms from |
| `PATCH` with `base_revision` | Save. Returns 409 if another tab saved in between, 422 with field errors if invalid. |
| `POST /preview` | Shows the effect on prices and the payload without saving |
| `revisions` and `revert/{id}` | Browse history; a revert creates a new revision |
| YAML export/import | Shows a diff before applying |
| `test/{section}` | Checks the EMHASS URL, the API key and the entities |

- **Live apply:** a `SettingsBus` publishes the changed paths, and each subscriber reacts only to its own:
  - tariff changes → recompute prices
  - `emhass.mpc.*` → retime jobs
  - `logging.*` → set logger levels
  - `inputs.*` → rebuild the HA watch list
  - The old "refresh everything" behaviour is gone.
- **Legacy import wizard:**
  - It reads the legacy runtime state from entity states: forecast source, extend days, interval, poll hours, Auto MPC.
  - It reads tariffs and the API key from the integration's options flow over the HA REST API, which returns the current values as defaults; the flow is then discarded.
  - If that read isn't permitted, it falls back to a paste form.
  - The result is a `legacy_import` revision.

### 3.3 Storage
- **Engine:** stdlib `sqlite3` in WAL mode, with a single writer via `asyncio.to_thread`.
- **Migrations:** numbered `.sql` files tracked with `PRAGMA user_version`.
- **`app.db`** (included in backups):
  - `settings_revision`
  - `price_day`: one row per CET delivery day, with state Preliminary/Final, fetch time, HTTP status and error.
  - `price_slot`: raw €/MWh, keyed by `start_utc`.
  - `forecast_snapshot` and `forecast_point`: kept 30 days, which is enough to show forecast accuracy.
  - `problem_event`, `kv`.
- **`runs.db`** (excluded from backups):
  - `run`: id, job, trigger, mode, start/finish, outcome, summary, error, settings revision.
  - `run_artifact`: gzipped `inputs`, `request`, `explain`, `validation`, `response`, `emhass_last_run`, `plan`.
  - `log`.
  - Retention: artifacts 7 days, run summaries 30 days, pinned runs forever.

### 3.4 Scheduler (small custom asyncio scheduler, ~250 lines)
- **Why not APScheduler:** APScheduler 3 handles some things badly that we need, and version 4 is still pre-release. MFFR's three thread-based schedulers are the pattern to avoid. The things we need are:
  - next-run times that depend on data, such as the Nord Pool polling state machine
  - per-run records linked to log lines
  - waiting out a hazard window before firing
  - tests driven by a fake clock
- **How it works:**
  - **One loop, many jobs:** each job has a trigger and an `asyncio.Lock`.
  - **Overlaps** are skipped and recorded as `skipped:overlap`.
  - **Missed fires:** a fire later than its grace period is recorded as `missed`, so "the scheduler didn't fire" becomes visible.
  - **Time handling:** quarter-hour triggers are computed in UTC; daily jobs use `zoneinfo`, so DST is handled.
  - **Controls:** every job can be paused, resumed or run immediately. `GET /api/jobs` returns each job's next run, last run and outcome.

| Job | Trigger | Notes |
|---|---|---|
| `nordpool.poll` | Next time comes from the polling state machine, re-evaluated every 60 s | Per-delivery-day state; legacy 13:45/fast/slow/stop-at-Final rules; backoff on errors |
| `forecast.ee.poll` | Every N h, with failure backoff (5→10→20 min, capped) | Fixes the "retry every minute" bug |
| `forecast.fi`, `pv.solcast` | HA WS `state_changed` (debounced), plus a reconcile every 15 min | No polling of HA |
| `mpc` | Each quarter at :13:00 (configurable) | Modes off / dry_run / live; waits out the hazard window if needed |
| `emhass.publish` | Each quarter at :00:02 | Live mode only; then fires the event and refreshes MQTT |
| `outputs.refresh` | Each quarter at :00:01, and on change | MQTT entities |
| `health.evaluate` | Every 60 s | |
| `emhass.config_check` | Hourly, at startup, and when EMHASS restarts | |
| `ml.fit` / `ml.tune` / `ml.predict` | Manual, optionally weekly | MPC pauses while a fit is running |
| `parity.check` | Each quarter at :14 | Phases 1–2 only |
| `maintenance.retention` | Daily 03:30 | |

### 3.5 Clients
- **HA:**
  - REST, plus a WebSocket at `ws://supervisor/core/websocket` with reconnect and backoff.
  - It subscribes to `state_changed` for the input entities and to `homeassistant_started`.
  - Every reconnect re-reads the watched states and re-publishes MQTT. This is also how an HA restart is detected.
  - `EntityCache.read()` returns either the value with its age, or the reason it's unusable: `missing`, `unavailable`, `non_numeric` or `stale`.
- **EMHASS:** `healthz()`, `last_run()`, `plan()`, `get_config()` and `action(name, payload, timeout)`.
  - Features are gated on the version reported by `healthz`: `/api/v1/plan` needs ≥0.17.9, and the start-grid race fix arrived in 0.18.2.
  - One global lock ensures only one action runs at a time.
  - A 200 from an action proves little, so every action is followed by `GET /api/v1/last-run`.
- **Supervisor:** an async port of MFFR `backend/addon_config.py` (`_call`, `/addons/self/*`), plus `/addons` and `/services/mqtt`.
- **Upstream HTTP:** one `httpx.AsyncClient` per upstream. Event hooks log requests at DEBUG with secrets redacted and attach request/response metadata to the current run.

### 3.6 Domain modules (pure functions; `now` and the timezone are passed in; rounding only at boundaries)
- **`nordpool`:**
  - parses `multiAreaEntries` and `areaStates` from `GET https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices?date=…&market=DayAhead&deliveryArea=EE&currency=EUR`
  - addresses the request by **CET delivery day**
  - keeps raw €/MWh
  - accepts 15-minute or hourly data
  - `poll_policy` returns the next action plus a readable reason, e.g. "tomorrow not published; fast window, next in 5 min".
- **`forecast`:**
  - A `ForecastProvider` registry with `ee_eupowerprices` (`GET https://api.eupowerprices.com/v1/forecasts/EE/latest`, header `X-API-Key`) and `fi_ha_entity` (`sensor.nordpool_predict_fi_price`.forecast, c/kWh).
  - `stitch()` expands hourly points into 15-minute slots after the last actual slot, up to N days. Each slot is tagged `origin=actual|forecast:<id>`, and gaps are reported.
- **`tariffs`:**
  - **Packages:** MFFR's `PACKAGES` from `backend/fees.py`, converted from cents to €/kWh, with valid-from dates.
  - **Holidays** come from the `holidays` EE library, cross-checked against MFFR's list.
  - **`engine.price_slot()`** returns the full breakdown: period (day/night/peak), the reason for it ("weekend", "holiday: Võidupüha", "night 22–07"), each component, VAT, import total and export total.
  - **`legacy_compat=True`** reproduces the old 0.001 rounding and the fixed 22–07 window exactly. It is used only for parity checks.
- **`pv_solcast`:** maps `detailedForecast[].period_start` to 15-minute slots, keyed by timestamp. This makes it DST-safe and keeps a missing day from shifting the rest. It reports coverage instead of padding with zeros.
- **`mpc`:**
  - `inputs` is a frozen snapshot, and every value records where it came from, e.g. "62 % from sensor.ev6_battery_soc, 34 s old, ÷100".
  - `anchor_slot(submit_at, method_ts_round)` computes which slot EMHASS will treat as the start. The rounding rule is read from EMHASS `/get-config`. This replaces the "drop the first element after 450 s" trim.
  - `payload.build()` returns the EMHASS payload plus an **Explain** table that maps each position i to its slot time and the load cost, production price and PV values.
    - `end_timesteps` is derived from the deadline relative to the anchor, which fixes the EV off-by-one.
    - The legacy `num_lags`, history-days and `delta_forecast_daily` formulas are kept and shown.
- **`validate`:**
  - **Refuses to send** when any of these holds:
    - a list is empty or shorter than the horizon, or the lengths differ
    - a value is NaN
    - the first slot is not the anchor
    - SOC is unavailable and the policy is `refuse`
    - SOC is outside [0,1]
    - the deadline is beyond the horizon
    - the EMHASS config is incompatible
    - the legacy integration is still driving EMHASS
  - **Sends but warns** for: low PV coverage, stale inputs, or a `num_lags` that no longer matches the last fit.

### 3.7 MPC and publish pipeline
- **MPC run:**
  1. Pre-flight: check the mode, the lock, whether an ML fit is running, and whether the legacy integration is still driving EMHASS.
  2. Snapshot the inputs.
  3. Anchor the series and build the payload.
  4. Validate it.
  5. In `dry_run` mode, stop here.
  6. In `live` mode, call `POST /action/naive-mpc-optim`, then `GET /api/v1/last-run`.
  7. Fetch `GET /api/v1/plan` and accept it only if `generated_at` matches this run. EMHASS keeps serving the previous plan after an Infeasible run.
  8. Record the outcome: `ok`, `infeasible`, `error`, `timeout`, `refused` or `dry_run`. Every step is stored as an artifact.
- **Re-runs:** "Re-run" always builds a fresh payload. Replaying an old MPC payload is blocked, because its positions would be wrong now.
- **Publish (live mode):**
  1. `POST /action/publish-data`.
  2. Read the current-slot row from the verified plan.
  3. Fire the HA event `emhass_lens_plan_published`. Its data contains `run_id`, `slot_start`, the current `p_batt/p_grid/p_pv/p_pv_curtailment/soc_opt/p_deferrable0` and the current import/export price, so the automation doesn't race the sensors.
  4. Refresh the MQTT entities.

### 3.8 MQTT output (device "EMHASS Lens")
| Entity | Type | Notes |
|---|---|---|
| Import price now | sensor, €/kWh, `measurement` | Small attributes: slot_start, next, is_forecast. Can replace `sensor.nordpool_import` in `battery_energy_cost`. |
| Export price now | sensor, €/kWh | Can replace `sensor.nordpool_export` in the inverter feed-in limit and in `notify.yaml` |
| Problem | binary_sensor, `problem` | Attribute: active problem keys |
| Last successful MPC | sensor, timestamp | Attributes: outcome, run_id |
| Auto MPC | switch | Lets HA automations (e.g. during an mFRR session) pause or resume planning |
| Run MPC now | button | |

- **Discovery:** device-based, with `unique_id`s, an availability topic and a last will. The App re-publishes when it sees `homeassistant/status online`.
- **Interface:** an `HaOutput` protocol, so a REST adapter could be added later. Only MQTT and `none` are built now.

## 4. Transparency

- **Logging:**
  - stdlib `logging`, one logger per component (`emhass_lens.prices`, `.emhass`, …), with `run_id` and `job` injected through contextvars and secrets redacted.
  - **Handlers:**
    - stdout as readable text, which feeds the Supervisor Log tab
    - a ring buffer (5,000 lines) streamed to the UI over SSE
    - batched inserts into `runs.db.log`
  - uvicorn logs go through the same pipeline, without the noise from polling and SSE.
  - Log levels change live from Settings.
- **Run records:**
  - Every job runs inside `runs.start(...)`. That records inputs, request, response, duration and outcome, plus the settings revision.
  - All log lines carry the `run_id`.
  - A run can be downloaded as a JSON bundle.
- **Health:**
  - Each problem has a key, severity, detail, start time, a hint on how to fix it, and a link to the run.
  - **Price rules:**
    - Nord Pool is failing N times in a row
    - tomorrow's prices are still missing after 15:30 (warning) or 18:00 (error)
    - there are gaps in today's prices
    - the forecast is stale
  - **Input rules:**
    - FI, Solcast or an MPC input entity is unavailable
    - the HA WebSocket is down for more than 60 s
  - **EMHASS rules:**
    - EMHASS is unreachable
    - its config is incompatible
    - the last run was infeasible or errored
    - the plan is more than 2 slots old while auto mode is on
  - **Scheduler and job rules:**
    - a job was missed or overran
    - K MPC refusals in a row
    - publish failed
    - `num_lags` changed since the last fit
    - both the legacy integration and the App are driving EMHASS
    - the settings are invalid
    - MQTT is unavailable
- **Persistent notification** `emhass_lens_problems`:
  - raised only after a problem persists for N minutes, so it doesn't flap
  - links to the App page
  - dismissed on recovery
  - off during Phase 1
- **EMHASS config checks** (read from `/get-config`; each shows expected value, actual value and an explanation):

| Setting | Expected |
|---|---|
| `optimization_time_step` | 15 |
| `method_ts_round` | `nearest` or `first`; `last` is refused |
| `continual_publish` | false while the App publishes |
| `time_zone` | equal to HA's |
| `sensor_power_load_no_var_loads` | equal to `var_model` |
| Deferrable-load array lengths | consistent with the App's deferrable loads |
| `historic_days_to_retrieve` | at least what `num_lags` needs |
| EMHASS version | at least 0.17.9 |

## 5. UI (React 19, Vite, TypeScript strict, TanStack Query, uPlot)

- **Ingress-safe by construction:**
  - Vite `base:'./'`, `API_BASE='.'`, `HashRouter` (so links like `#/runs/123` work behind Ingress), a relative `EventSource('./api/events')`.
  - MFFR's no-cache `index.html` handling and its `/api/version` + `started_at` reload banner.
- **Writes only through Ingress:** MFFR's client-IP check `_through_ingress` (172.30.32.2). The direct port is read-only with secrets masked, and there is no CORS middleware.
- **Data:** one SSE stream (log lines, run updates, problems, settings changes, job changes) tells TanStack Query what to reload. If Ingress buffers SSE, the UI falls back to polling.
- **API types:** generated with `openapi-typescript`. CI fails if they drift from the backend.
- **Charts:** uPlot (~50 KB). It draws step lines, shaded forecast regions and a "now" marker, keeps the cursor in sync across charts, and handles 700+ points × 10 series easily.
- **Header strip on every page:**
  - mode badge OFF / DRY RUN / LIVE
  - **who is driving EMHASS** (App, legacy or nobody)
  - HA WS status
  - EMHASS reachability and version
  - problem count
  - a "Run MPC now" button

| Page | Contents |
|---|---|
| **Plan** (home) | **This slot:** what EMHASS wants right now (battery, grid, PV, curtailment, EV) and what the automation receives. **Plan chart:** SOC, P_batt (charge/discharge coloured), P_grid, P_PV, P_Load, P_deferrable0, with import/export price steps underneath on a synced cursor. The previous run is drawn as a ghost line, and slots that changed are listed. **Run status:** last run (when, duration, optim_status, cost_profit) and next run countdowns. |
| **Inputs** | **Prices:** a today/tomorrow/extended chart (actual solid, forecast dashed, Final/Preliminary chip) and a per-slot breakdown table plus stacked component chart with the reason for each period. **Sources:** fetch status per delivery day. **Forecast accuracy:** forecast vs actual (MAE). **PV coverage. SOC and deferrable loads:** each value with its source entity and age. |
| **Runs** | A swimlane timeline per job, coloured by outcome, and a filterable list. Opening a run shows: inputs with where each came from, validation issues, the request with the **Explain** view (positional payload next to timestamps), the response, EMHASS stage times, linked logs, settings revision, re-run, and bundle download. |
| **Logs** | Live tail with pause, level and component filters, search, run_id filter, history range and download |
| **Health** | Active and past problems; EMHASS config checks; connections with latency; the jobs table (pause, run now); parity reports (Phases 1–2); a legacy-dependency scan (Phase 4); storage stats |
| **Settings** | Schema-driven forms per section: units, an entity picker that shows live state, masked secrets, a list editor for deferrable loads. Validation errors appear inline. Saving shows a diff preview and accepts a comment, and a draft can be previewed for its effect on prices and the payload. Also: a history tab with revert, YAML import/export, the legacy-import wizard, and the EMHASS "Test connection" button. |

## 6. Phases, exit criteria and rollback

Phase 1 should be running before **2026-10-25**, the end of DST (a 25-hour day), so that parity covers it.

| Phase | In scope | Exit criteria | Rollback |
|---|---|---|---|
| **0. Scaffolding** | **Repo:** create `~/Documents/bla/emhass-lens` (I'll confirm before creating the GitHub repo and before the first push), MFFR packaging and CI. **Backend:** bootstrap, logging pipeline, both DBs, settings store with revisions, scheduler with a heartbeat job. **UI shell:** header strip, Logs, Settings + history, Jobs. | CI green (tests, lint, typecheck, native amd64+arm64 builds). App installs on the real HA from the repo URL. Logs stream live **through Ingress** and also appear in the Supervisor Log tab. A setting change applies live, and its history survives a restart. `safe_mode` and the watchdog work. | Uninstall; nothing else is touched |
| **1. Shadow + parity** | Prices, forecasts, tariffs and PV. The MPC builder runs at :13 with EMHASS mode forced `off`, so only GETs go to EMHASS. Config checks, health (notifications off), legacy settings import. Plan page shows the plan the legacy integration produced; Inputs, Runs and Health pages. **Parity job** at :14: compares the legacy `raw_prices`/`import_cost`/`export_cost` (by timestamp), `prices_from_now`, `solcast_forecast_15min` and `emhass_last_mpc.payload` against the App's values. With `legacy_compat` the match must be exact; otherwise expected differences are classified automatically, each backed by a test. Legacy MPC durations are recorded to size the :13→:15 time budget. | ≥7 days, including 2026-10-25. 100 % of parity checks pass or are explained. Tomorrow's prices arrive within the fast interval every day. 0 unhandled exceptions. App problems are quiet whenever the legacy integration is healthy. EMHASS config checks pass or are consciously accepted. RSS < ~150 MB. | Nothing to undo: the App is read-only towards HA and EMHASS |
| **2. EMHASS orchestration** | MPC, publish and ML jobs. A double-driver guard. Notifications on. A **"Take over"** button turns off `switch.nordpool_ee_prices_emhass_auto_mpc` (stopping both legacy MPC and legacy publish), verifies it, sets the App to live and records a revision. **"Hand back"** does the reverse. ≥3 days in `dry_run` first; cut over outside 13:45–15:00 and away from midnight, then watch the first 4 quarters. | 7 days live: MPC success ≥99 %, every refusal explained, p95 duration < 90 s, publish 100 %, every plan verified by `generated_at`, 0 double-driver events. You confirm the inverter behaves as before. | "Hand back" (one click, under a minute). Legacy stays installed, and parity keeps running to show drift. |
| **3. HA outputs + event** | MQTT device and entities. Event after each publish. **DOCS snippet:** add an `event` trigger to `emhass-consolidated-inverter-control.yml` and keep the :07 time trigger as a fallback, conditioned on "no event in the last 60 s". Point the feed-in limit and `notify.yaml` at the App's export price sensor, and `battery_energy_cost` at its import price sensor. | 3 days of event-triggered runs with lag under 2 s. Entities survive an HA restart (retained discovery). The dependency scan (WS `search/related` on each legacy entity, shown on the Health page) finds 0 outside references. | Turn MQTT off. The automation falls back to its time trigger. |
| **4. Retire HACS** | In the old repo: a final release with a README banner and an HA repair issue that points to EMHASS Lens. Take a full HA backup, remove the config entry and the integration, then archive the repo. | 14 days without the legacy integration | Reinstall the final tag, restore the backup, then "Hand back" |
| **5. Inverter control (optional)** | A controller profile maps the plan row to Sofar service calls within hard limits. A per-slot decision log records inputs, rule, command, HA result and readback. A dry-run "agreement %" compares against what the HA automation actually did. A stale plan triggers a safe command. Kill switch in the App and over MQTT. The rules follow the current (template) version of the automation. | 7 days dry-run with ≥99 % agreement → live, with the automation disabled but not deleted | Turn the controller off and re-enable the automation |
| **6. EV charger control** | The automation "EV Charging: Combined EMHASS & Excess Solar" moves into the App branch for branch: the target-SoC stop, EMHASS mode (follow P_deferrable0) and Excess Solar mode. A decision log with inputs, branch, calls, readback and the phone message; dry run compares each decision with what the automation did to the charger. Live refuses above the maximum current or while the interlock automation is on. | 7 days dry run with high agreement → live, with the automation disabled but not deleted | Charger control off, automation on |
| **7. Qilowatt market controller** | The market automation moves into the App behind one Sofar writer: settle, hysteresis, deadband and cooldown as pure logic; a persisted session; shadow mode compares with the automation; a session end goes straight to the plan's targets (one inverter write). Only after Phase 5 is live. | ≥7 days shadow with ≥99 % agreement including real sessions → live | Market mode off, automation on (the mirrored select and switch let it continue) |

## 7. Testing and verification

**Tools:** pytest, pytest-asyncio, respx, time-machine plus `FakeClock`, syrupy snapshots, hypothesis, ruff, pyright. Frontend: `tsc --noEmit`, eslint, vitest, and a check that the generated API types are current.

**Recorded fixtures** (redacted):

| Source | Cases |
|---|---|
| Nord Pool | normal 96-slot day; Preliminary→Final; tomorrow 404/400; 2026-03-29 (92 slots); 2026-10-25 (100 slots); hourly data; the CET-vs-local day boundary |
| eupowerprices | ok, 401, 429, 500 |
| Solcast | normal day, DST days, a missing day sensor |
| FI forecast | an attribute sample |
| EMHASS | `get-config` (your live config), `plan` ok/no-run, `last-run` ok/infeasible/error, action 400 log text, `healthz` 503 |

**Golden tests against the old code:**
- Copy the legacy pure math into `tests/legacy/legacy_math.py`. That means `_append_forecast`, `_get_calculated_prices` and `_get_solcast_forecast` from `sensor.py`, and the payload assembly from `__init__.py:119-178`, using a `dt_util` shim.
- On non-DST days, the App with `legacy_compat=True` must equal the legacy output exactly.
- Every intentional difference gets its own test, named after the bug it fixes.
- The holidays and peak windows are cross-checked against MFFR `fees.py`.

**Scheduler and policy tests:**
- MPC fires at :13:00 every quarter.
- The hazard wait (version-gated).
- A missed fire after a simulated suspend.
- The overlap skip.
- Daily jobs across DST.
- The Nord Pool policy, table-driven over a full day × states.
- EE backoff.

**Contract tests:** a pydantic model of the payload with snapshots; the anchor and `end_timesteps` invariants. Optionally, a nightly CI job runs a real EMHASS 0.18.3 container and calls `naive-mpc-optim`.

**API tests:** settings 422/409/revert, the Ingress-only write guard, SSE.

**CI:** `ci.yml` runs backend + frontend + a `docker build` without push + `frenck/action-addon-linter`. `addon-image.yml` (from MFFR) runs only after CI passes.

**End-to-end checks, by phase:**
- **Locally:**
  - `uv run pytest && uv run ruff check && uv run pyright`
  - `npm run typecheck && npm run lint && npm test`
  - `docker compose up` against the real HA (HA_URL + long-lived token), then open the UI.
- **On HA:**
  - Add the repo URL, or use `scripts/make-local-addon.sh` → `/addons` for a local build.
  - Install, open from the sidebar, and check every Phase 0 exit criterion.
- **Phase 1:** read the parity reports on the Health page every day, and check by hand at least one run's Explain view against EMHASS's own result table (like `plan.txt`).
- **Phase 2:** watch the Plan page and the inverter for the first 4 live quarters; test "Hand back".
- **Phase 3:** restart HA and check that the MQTT entities and the event-triggered automation recover.

## 8. What to reuse

| From | What |
|---|---|
| MFFR `Dockerfile`, `.github/workflows/addon-image.yml`, `scripts/make-local-addon.sh`, `repository.yaml`, `mfrr_tracker/config.yaml` | Packaging, per-architecture builds on native runners, local build |
| MFFR `backend/start.py` | The timestamped stdout wrapper and the options.json bootstrap idea (not the env-globals part) |
| MFFR `backend/addon_config.py`, `api.py` (`UIFiles`, `_through_ingress`) | Supervisor calls, Ingress-only writes, no-cache index |
| MFFR `backend/ha.py`, `ha_statistics.py` | Log each fetch error only once (`_fetch_failed`); the WS handshake and the `ws_url()` mapping |
| MFFR `backend/fees.py`, `price_settings.py` | Elektrilevi packages, peak windows, holidays (cents → €/kWh) |
| MFFR `frontend/src/ConfigPanel.jsx`, `App.jsx` | Ideas for the version banner, restart polling and the entity datalist picker |
| Legacy `coordinator.py:285-468`, `sensor.py:52-174, 317-360`, `__init__.py:27-185` | The behaviour reference and golden-test source |
| `emhass/` clone (v0.18.3): `web_server.py`, `docs/api/v1/*.schema.json`, `forecast.py:283-305`, `utils.py:115-153` | The EMHASS contract (plan/last-run schemas, anchoring rules) |

## 9. Known bugs in the current code that the rewrite fixes by design
1. **EV deadline one slot late.** The anchor trim doesn't decrement `end_timesteps` (`__init__.py:142-159`).
2. **SOC failure is silent.** An unavailable SOC entity raises `float("unavailable")` before the EMHASS call. Nothing is recorded, and the Problem sensor stays off. A *missing* entity is silently replaced by a 0.5 SOC.
3. **Failed EE forecast fetch retried every minute.** `last_forecast_poll` is only set on success.
4. **Spot price rounded to 0.001 €/kWh** (`coordinator.py:467`).
5. **Solcast reshaping:** assumes 48 periods from midnight (wrong on DST days), shifts all later days when one is missing, truncates with `int()`, and pads with zeros silently.
6. **Settings split** across the config entry, the Store and hard-coded values. Every setter forces a full Nord Pool + EE refetch.
7. **publish-data vs continual_publish ambiguity.** The README contradicts the code.
8. **MPC is fire-and-forget with no lock.** `last_mpc` is stamped before the outcome is known.
9. **Nord Pool requested by local date instead of CET delivery day,** so a cold start misses local 00:00–01:00. A failure for today also blocks tomorrow.
10. **The current slot can shift.** "Prices from now" comes from a possibly stale entity, so the whole series can be one slot off.
11. **`num_lags` is tied to Extend Days** with no re-fit and no warning.
12. **Attributes over the recorder's 16 KB limit,** and prices are recomputed about 10 times per tick.
13. **The night window is hard-coded** to local 22–07, with no package choice or peaks.

## 10. Open questions to verify (most during Phase 0–1, none blocking the start)
1. **EMHASS deployment:** which version is deployed (need ≥0.17.9, ideally ≥0.18.2)? And which address the App container can reach: `<hash>-emhass:5000` or host `172.30.32.1:5001`?
2. **`/get-config` key names:** check them against a live response.
3. **Elektrilevi night window in summer:** is it 22–07 or 23–08? The `clock_basis` setting covers either answer.
4. **Your live tariff values and package:** the defaults match Võrk 4. Is aktsiis still 0.21 c, or the 0.307 c that applies from 1 May 2026? The legacy import wizard captures the live values.
5. **FI forecast:** does it include Finnish VAT (25.5 %)? And does eupowerprices include VAT?
6. **Where `sensor.nordpool_import` and `sensor.nordpool_export` come from today:** they're not created by this integration.
7. **`sensor.ev_charging_timesteps`:** is it relative to now? Could an `input_datetime` deadline replace it?
8. **`forecast-model-predict`:** is it still needed alongside `load_forecast_method=mlforecaster`?
9. **Platform checks:** does SSE buffer through Ingress? Does the Supervisor `/addons` listing work with the default role? Are the `X-Remote-User-*` headers present? Are Python 3.14 wheels available on aarch64?
10. **Mosquitto:** is it installed? If not, Phase 3 includes installing it.
