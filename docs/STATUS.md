# Status

The newest entry is on top. Read this first when you pick the work up on another machine.

## How to resume on another computer
```sh
git clone https://github.com/anton4/emhass-lens && cd emhass-lens
cd backend && uv sync && uv run pytest -q          # needs uv + Python 3.14
cd ../frontend && npm ci && npm test               # needs Node ≥ 22.12
```
Then open Claude Code in the repo and say something like "continue EMHASS Lens from docs/STATUS.md". CLAUDE.md has the commands and conventions, and docs/PLAN.md has the approved plan.

## Phase overview
| Phase | State |
|---|---|
| 0. Scaffolding (packaging, settings with history, scheduler, runs, live logs, UI shell, CI) | done; the App image builds for amd64 and aarch64 |
| 1. Prices, forecasts and PV in shadow mode, plus parity with the HACS integration | done; verified against the real integration (e2e) |
| 2. EMHASS orchestration (dry run → live, take over / hand back) | done; verified against real EMHASS 0.18.3 (e2e) |
| 3. MQTT entities and the plan-published event | done; verified against a real HA and Mosquitto (e2e) |
| 4. Retire the HACS integration | waiting for your validation; runbook in docs/RETIRING_HACS.md |
| 5. Inverter control in the App (optional) | done, experimental: off by default; dry run compares with your automation. Rules follow the template version of the automation (2026-10-10) |
| 5c. Hold and resume around market sessions (mFRR) | done, unreleased: off by default (Settings → Market session hold); the plan is re-applied with at most one inverter write when a session ends |
| 6. EV charger control in the App | done, unreleased, experimental: off by default; dry run compares with the automation "EV Charging: Combined EMHASS & Excess Solar" |
| 7. Qilowatt market controller in the App | done, unreleased, experimental: off by default; shadow compares with the automation; live runs the sessions behind one Sofar writer and hands the inverter back to the plan with one write. Go live only after Phase 5 is live |

## Decisions for the owner (left open on purpose)
- **License:** the repo has no LICENSE file yet (the old repo didn't either). Pick one (MIT is common for HA Apps).
- **ghcr packages:** already public. They inherit the public repo's visibility, and an anonymous pull works.

## Open questions to verify on the real Home Assistant
These come from docs/PLAN.md §10:
1. The deployed EMHASS version (need ≥ 0.17.9 for `/api/v1/plan`, ≥ 0.18.2 avoids the grid-boundary waits, 0.18.5 recommended), and the address the App can reach it on.
2. Whether Server-Sent Events stream through Ingress without buffering. The Logs page falls back to polling if they don't.
3. Whether Mosquitto is installed (needed for Phase 3).
4. Your live tariff values: Võrk 4? Is excise 0.21 c or 0.307 c?
5. The Elektrilevi night window in summer: wall-clock 22–07, or winter-time 23–08?

## Log

### 2026-10-10: inverter rules follow the template automation (unreleased)
- **Why:** the owner rewrote "EMHASS: Consolidated Inverter Control" as a template automation (±100 W bands for grid and battery, "Charge battery and export some to grid" reachable, PV export gated on the export price, feed-in purely price-based). The App still mirrored the older `choose` version, so dry run would have disagreed.
- **Done:** `domain/inverter.py` decides exactly like the template version; rule ids are the automation's mode names (`force_charge`, `self_use`, …); every grid/battery combination maps to a mode. `low_export_price` now means "at or below" and defaults to 0.03 (the live value; the stored 0.02 of an existing install is kept, set it by hand). DOCS.md gained an "Inverter control" section.
- **Hold and resume around market sessions** (`services/external.py`, Settings → Market session hold, off by default): while the Qilowatt automation's session select is `buy`/`sell`, MPC runs are built but not sent, publishes are skipped and the inverter isn't touched (`binary_sensor.emhass_lens_hold`, the Driver card). When it ends, the `external.resume` job waits for the enable switch, publishes the stored plan once and chains the inverter decision, which writes only what differs. "Re-run MPC after a session" (off by default) re-plans afterwards without a second inverter write in the slot (`chain_inverter=False`). Tests in `tests/test_external_control.py`.
- **EV charger control (Phase 6)** (`domain/charger.py`, `services/charger.py`, Settings → EV charger control, the EV charger page): mirrors the automation "EV Charging: Combined EMHASS & Excess Solar (Modbus)" branch for branch: the target-SoC stop (after the holding time), EMHASS mode (follow `P_deferrable0`: start, adjust, pause) and Excess Solar mode (PV surplus with the stale-PV guard). Jobs: `charger.decide` (after each publish, on a change of `sensor.p_deferrable0`, quarter-hour fallback), `charger.tick` every minute at :55, `charger.soc_stop` (dynamic), `charger.compare` (dry run, a few seconds after each decision; polls the charger). Live mode presses start/stop, sets the current limit and the target SoC, sends a phone message (new Settings → Notifications → Mobile notify service) and reads back; it refuses above the maximum current, without HA, or while the automation set as the interlock is on. Mirrored quirks: after the stop sets the target to 100 %, EMHASS mode resumes charging a minute later (the automation does too, its "set mode Manual" step is disabled); a pause isn't repeated every minute while the charger already shows 0 A. Tests in `tests/test_charger.py` and `tests/test_charger_service.py`; an e2e dry-run check.
- **Qilowatt market controller (Phase 7)** (`domain/market.py`, `services/market.py`, `services/sofar.py`, Settings → Qilowatt market control, the Market page): mirrors "Qilowatt: Master Market Controller" guard for guard (hysteresis with enter/exit gates, proportional deadband, cooldown with its bypasses, low-SoC and source-lost ends, the Fusebox sell helper, feed-in only while selling). `SofarWriter` is now the one writer to the Sofar for both the plan-driven inverter decision and the market controller: minimal calls, readback, a commit log in app.db (`sofar_commit`, so the cooldown survives a restart) and a press log (`sofar_press`, wear shown on the Market page). Sessions live in `market_session`. Triggers: the qw sensors through the WebSocket with a settle time (one decision per burst), the SoC below the minimum for 10 s, every minute at :15 (recorded only while a session is open), start-up and reconnect. The scheduler gained `run_now(trigger="event")` (always recorded) and `Job.coalesce` (a fire during a run queues one rerun). Live: session select and the EMHASS automation switch are kept like the automation keeps them; a session end closes the session and runs `inverter.decide` with `after_market`, which writes the plan's targets (feed-in included) in one go, the safe state only when no fresh plan exists; `external.resume` then only re-plans if that is on. Kill switch: `POST /api/market/reconcile {"force_end": true}` ("End session now"). Health: live without inverter live, entities missing, the HA automation still on, a session open in safe mode. Tests: `tests/test_market.py`, `tests/test_market_service.py`, scheduler tests; an e2e shadow check.
- **Deviations from the automation, on purpose:** a session end hands the inverter to the plan instead of writing "self-use, grid 0" first (one apply press instead of two); three sensor updates settle into one decision instead of three queued runs. Shadow comparisons expect what the automation does.
- **Verified:** 217 backend tests, 64 frontend tests, ruff, pyright, lint and build. **e2e:** 15/15 checks pass against HA 2026.10.0, Mosquitto and EMHASS 0.18.3 (without the HACS integration), including the inverter dry run with the new rule ids, the EV charger dry run and a market shadow session that leaves the registers untouched. `up.sh` now waits for EMHASS's web server before returning; with cached images the checks used to start a few seconds before EMHASS listened, failing five of them.
- **EMHASS 0.18.0–0.18.5 taken in** (the changelog was read against the App's integration; the 0.18.5 source is the reference): the P10 companion `pv_power_forecast_p10` (0.18.4) is built from the Solcast `pv_estimate10` the App already reads and sent to EMHASS ≥ 0.18.4 unless the estimate is P10 itself (`Pv.send_p10`, `payload.P10_VERSION`); `def_current_state` (0.18.2 fix) from a new per-load *Running now* entity + states (`DeferrableLoad.running_entity`, `read_match`); multi-battery columns `SOC_opt_k` (0.18.0) in the Plan page, the slot tile and the event (`socColumns`, `event_data` fallback) with a configuration warning; version advice (0.18.5 recommended: DST-safe horizon, `Optimal_Inaccurate` = ok) and hints for `publish_horizon_attributes` and `weather_forecast_pv_quantile_bias` in `emhass_checks.py`. The parity build (`compat=True`) sends neither new key, so the HACS comparison stays clean. Not taken in, on purpose: capacity charges (no such tariff here), thermal/heat topology, VictoriaMetrics, inverter efficiency curves, `battery_soc_final_reward_factor` (EMHASS-side configuration; documented in DOCS.md). e2e default image is 0.18.5; the live run now checks the P10 pair, and 16/16 checks pass on both 0.18.5 (P10 sent and accepted) and 0.18.3 (P10 withheld).

### 2026-10-09 (late night): 0.2.5–0.2.8 after trying it on the real HA
- **Saving through the user's nginx.** The proxy refuses PUT/PATCH; the browser only shows "Failed to fetch" / `ERR_HTTP2_PROTOCOL_ERROR`. The UI now writes with POST only (`/api/settings/save`, `/api/settings/change`), and the API client offers only get/post (0.2.5).
- **Health check while starting.** It now runs every 2 s during start-up, so Home Assistant shows the App as started within seconds (0.2.5).
- **Settings review (0.2.6):**
  - Each change is named by its place in the form and jumps to the field.
  - Changed fields are highlighted.
  - Each field can be reverted on its own, and "Discard all" is also offered during the review.
- **Plan charts (0.2.7):**
  - Each y-axis fits its own data.
  - Drag zooms all three charts into a time range, snapped to quarter-hours, and the y-axes refit.
  - Double-click or "Reset zoom" undoes it.
- **Secret fields (0.2.7 / 0.2.8):**
  - An eye button shows what was typed.
  - It can also show the stored value via `POST /api/settings/secret`. That only works through Ingress, and each reveal is logged without the value.
- **Git history:** rewritten to the noreply identity `anton4 <5539972+anton4@users.noreply.github.com>`, and the old CI runs were deleted. Every machine pushing here must use that identity, then `git fetch && git reset --hard origin/main`.
- **Known:** `frontend/src/lib/prices.test.ts` fails under an Estonian locale (the formatter uses "−"); CI runs in English.

### 2026-10-09 (night): code review fixes, 0.2.4
- **Code review of the backend's critical paths found:**
  - Nord Pool polling could loop every second on unexpected responses.
  - The inverter decision could read EMHASS's sensors from the previous slot.
  - Live inverter writes relied on a possibly stale WebSocket cache for the mFRR interlock.
  - Some MPC outcomes could be wrong.
  - MQTT entities stayed "available" after a stop.
  - Take over could leave nobody driving EMHASS.
- **All fixed, each with a regression test** (`backend/tests/test_review_fixes.py`). Released as **0.2.4**.
- **Merge note:** 0.2.3 was released from another session (entity search as you type, plus a logging fix). My review fixes were rebased on top of it, with no lost work.
- **Git identity:** the other machine commits as `Jorma <you@example.com>`. Set `git config --global user.email` there if that isn't intended.

### 2026-10-09 (night): 0.2.0 / 0.2.1 released
- **0.2.0** contains all phases so far: Plan, Inputs, Inverter, Runs, Logs, Health and Settings. **0.2.1** adds one Plan page fix.
- **Images:** `ghcr.io/anton4/emhass-lens-{amd64,aarch64}` are public.
- **Checked by hand in Chrome** with real data from the e2e stack: the Plan page (charts, SOC, prices, changes), the Inputs page (price breakdown) and the Inverter page.
- **e2e:** 16/16 checks pass.

### 2026-10-09 (late evening): verified end to end, inverter control started
- **New e2e harness** (`e2e/`). It runs a real HA 2026.10, the real HACS integration, Mosquitto and the real EMHASS 0.18.3 in Docker, and `./check.sh` passes 13/13 checks:
  - **Home Assistant:** the WebSocket and entity readings with provenance work.
  - **Parity:** the match with the running HACS integration is exact: 192/192 prices, 125/125 "from now" prices and PV.
  - **Settings import:** works, and recognises the Võrk 4 rates.
  - **EMHASS:** the config checks pass. Dry run works. A live run produced a plan whose first row is exactly the computed anchor slot.
  - **Publish:** publish-data plus `emhass_lens_plan_published`, with values equal to `sensor.p_batt_forecast`.
  - **MQTT:** the entities are created, the Auto MPC switch works both ways, and they recover after an HA restart.
  - **Notifications:** a persistent notification is created and dismissed again.
- **Fixed after e2e:**
  - EMHASS discovery works with the default Supervisor role (via the known slug `5b918bf2_emhass`).
  - MQTT entity ids are predictable (`sensor.emhass_lens_import_price` and so on).
  - Health is re-checked right after entity changes.
  - Tokens are masked.
  - Retention now prunes prices, forecasts and plans.
- **Experimental inverter control:** it decides each slot exactly like your automation, rule by rule, and in dry run compares with what the automation set. Live mode needs explicit opt-in.

### 2026-10-09 (evening): Phases 0–3 backend, Phase 0 UI
- **Repo:** created at https://github.com/anton4/emhass-lens (public). CI is green, and the first App image (0.1.0, amd64 + aarch64) is on ghcr.io.
- **Backend (Python 3.14, FastAPI):**
  - **Platform:** settings with revisions, a scheduler, a run recorder with artifacts, and a logging pipeline (stdout, live UI, SQLite).
  - **Inputs:** Nord Pool per CET delivery day, the EE/FI forecasts, the tariff engine with Elektrilevi packages, and Solcast PV.
  - **MPC:** the payload builder with the Explain table and validation, plus a shadow MPC build every quarter-hour.
  - **EMHASS:** discovery, health checks, config checks and plan storage.
  - **Parity and problems:** a parity check against the HACS integration, health rules that raise problems, and the legacy settings import.
  - **Driving EMHASS:** live MPC with plan verification, publish plus the HA event, take over / hand back, ML fit/tune/predict, MQTT entities and HA notifications.
- **Tests:** 90 backend tests. They include golden tests showing the new price and payload math reproduces the HACS integration exactly on real Nord Pool data, and end-to-end tests against a fake Nord Pool, EMHASS, Supervisor and HA.
- **Fixed by design:** the EV deadline off-by-one, the SOC failure that went unrecorded, the forecast retry every minute, the Solcast DST/missing-day shift, the CET delivery-day bug, and 204 now means "not published".
- **UI:** the Phase 0 shell (Logs, Runs, Health, Settings with history/import/export). Phase 1 pages (Plan, Inputs, EMHASS/parity/problems on Health, Explain views) are being built.
- **Found along the way:** Nord Pool returns 401 for days older than a few days. Only recent days can be fetched, so history accumulates from the first run.

### Next steps
1. **On your real HA (needs you):**
   1. Add the repository and install. Check that logs stream through Ingress and that settings save.
   2. EMHASS should be found automatically; otherwise set the address in Settings → EMHASS.
   3. Run "Import from the HACS integration" (Health). Keep the mode **Off** and watch parity for a week, including the DST change on 2026-10-25.
   4. Switch to **Dry run** for a few days, then **Take over**.
   5. Optionally turn inverter control to **Dry run** and watch the agreement rate. First set Settings → Inverter control → Limits → "Block export at or below this price" to 0.03 (the live automation's value; installs made before this change still hold 0.02).
   6. Set Settings → Notifications → Mobile notify service (e.g. `notify.mobile_app_jormas_iphone`), turn EV charger control to **Dry run** and watch its agreement on the EV charger page. Set the automation entity under Charger entities as the interlock before going live.
   7. Turn on Settings → Market session hold once the Qilowatt automation's session select is in use, and watch a session: MPC runs show "held", then *Resume after a market session* follows the end.
   8. Later, with inverter control live: Settings → Qilowatt market control → **Shadow** for a week with real sessions (Market page agreement ≥ 99 %), then the runbook in DOCS.md to go live.
2. Phase 4 when happy: follow docs/RETIRING_HACS.md.
