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
| 5c. Hold and resume around market sessions (mFRR) | done, released in 0.3.0: off by default (Settings → Market session hold); the plan is re-applied with at most one inverter write when a session ends |
| 6. EV charger control in the App | done, released in 0.3.0, experimental: off by default; dry run compares with the automation "EV Charging: Combined EMHASS & Excess Solar" |
| 7. Qilowatt market controller in the App | done, released in 0.3.0, experimental: off by default; shadow compares with the automation; live runs the sessions behind one Sofar writer and hands the inverter back to the plan with one write. Go live only after Phase 5 is live |

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

### 2026-10-10 (evening): a tuned load model cuts the horizon instead of stopping MPC (unreleased)
- **Why:** after the owner pressed Tune, every run with tomorrow's prices and the forecast day (~233 slots) failed: EMHASS's tuner picks `lags_opt` from 6 h…3 days (`get_lags_list_from_frequency`) and a tuned model predicts only `lags_opt` steps (144 here). The plan went stale, Health raised `mpc.stale`, live inverter control refused. The tune also kept EMHASS from answering `/healthz` for ~3 min ("unreachable").
- **Done:** `domain/mpc/model_steps.short_model(body)`; `EmhassClient` splits EMHASS's JSON-list error bodies into lines (the error is the last ERROR line); `MlService.learn_steps/model_steps/forget_steps` (kv `ml.model_steps`, 24 h expiry, cleared by an App fit or tune); `build(..., model_steps=)` cuts the horizon with a `horizon_capped` warning (never in the compat build); `MpcService.on_short_model` ends the run with a clear error and re-plans once after the job lock frees (`_replan_after`); the cost-function comparison stops on it too; health `ml.model_short`; `EmhassService.act()` records `busy`, and a health timeout while busy is logged once instead of marking EMHASS unreachable; `EmhassStatusOut.busy_with/busy_since` on the EMHASS card; the Tune text explains the cut; the SSE stream cancels its pending `queue.get()` on disconnect. Docs: DOCS.md "The ML load forecast".
- **Verified:** 292 backend tests (`test_model_steps.py`, SSE leak test in `test_api.py`, which fails without the fix), 85 frontend tests.

### 2026-10-10 (evening): PV reserved for Excess Solar charging (0.3.7)
- **Why:** in Excess Solar mode the car eats the PV surplus behind EMHASS's back; EMHASS planned the battery and exports with it. EMHASS has no "reserved PV" input, so the App now sends a smaller `pv_power_forecast` (and `_p10`).
- **Done:** `settings.charger.pv_reserve {enabled, car_battery_kwh}`; `domain/ev_reserve.py` (`blocker`, `load_by_slot`, `house_load_profile`, `plan_reserve` → `EvReserve`), `solar_amps` shared with the controller; `ChargerService.refresh_load_profile()` caches the newest plan's `P_Load`, `pv_reserve(now, pv)` builds the reserve from the watched states, and the car's entities are watched even when the controller is Off; `MpcInputs.ev_reserve` is subtracted in `payload.build` (never in the compat build); `ExplainSlot.ev_reserved_w`, `EvReserveOut` on the preview, the inputs and explain artifacts and `ChargerStatus.pv_reserve`; the UI shows an "EV reserve" column, a note above the Explain table and a fact on the EV charger page. Docs: DOCS.md "Reserving PV for Excess Solar".
- **Verified:** 285 backend tests (`test_ev_reserve.py`, `test_mpc.py`, `test_charger_service.py`), 85 frontend tests.
- **Not done / to watch:** the plan's `P_PV` and the Plan page's PV accuracy show the net PV EMHASS was given, so a reservation looks like a PV miss there. (Run 755's "Unable to obtain 233 lags_opt values" turned out to be a tuned load model; see the next entry.)

### 2026-10-10 (afternoon): charge mode switch on the EV charger page (unreleased)
- `POST /api/charger/mode {option}` sets `input_select.ev_charge_mode` through HA (`ChargerService.set_charge_mode`, validated against the helper's options, then `charger.decide` when the controller isn't Off); `ChargerStatus.charge_mode` carries entity, current option and options; the page shows a segmented control in the header. Test in `test_charger_service.py`.

### 2026-10-10 (afternoon): the owner took over; a premature health error fixed (unreleased)
- The owner pressed Take over at 13:56 with parity 8/8. Six seconds later `mpc.stale` fired because its grace counted from the process start; `MpcService.live_since` (set when live + Auto MPC come on, via a settings subscription) is now the reference. Test in `test_phase2.py`.

### 2026-10-11: the owner's price sensors in the parity check (unreleased)
- **Why:** the owner asked whether the App uses the `sensor.nordpool_import` / `nordpool_export` templates (it doesn't; it prices from Nord Pool itself) and wanted a check against them. The templates carry Võrk 2 network rates while the contract and the App are Võrk 4.
- **Done:** `settings.prices.sensors` (import/export entity, tolerance), `domain/price_compare.py` (`sensor_intervals`, `compare` over hourly or quarter-hour intervals skipping forecast slots, `explain` naming the Elektrilevi package a constant per-period delta points at), `ParityService._price_sensors()` appended to the parity report; the run no longer noops when only the owner's sensors exist; `ParityView` uses a per-section label. Tests: `test_price_compare.py`, a phase-1 test with a Võrk 2 sensor.

### 2026-10-10 (night): storage retention and budgets, clean shutdown, backup and restore (unreleased)
- **Why:** the owner asked for automatic log/storage/database retention and cleanup, noticed the uvicorn traceback at every restart, and wanted a backup story that survives a wiped machine (the machine is backed up with the Google Drive Backup add-on; scope here is EMHASS Lens).
- **Storage (`services/storage.py`, `db/conn.py` page stats/VACUUM/dbstat, settings `Storage` with `Retention` moved from `Logging`, schema 3):** day-based rules now cover `problem_event`, `market_session` and `settings_revision`; pinned runs keep logs; a size budget per database trims the oldest calendar day of one table at a time in a fixed ladder with floors (`RUNS_LADDER`, `APP_LADDER`); checkpoints after the deletes; VACUUM when ≥ 20 % and ≥ 16 MiB are free and the disk has room; `maintenance.compact` (manual). `GET /api/storage`, Health → Storage card, rules `storage.over_budget.*`, `storage.disk_low`. Artifacts capped at 512 KiB; `costfun:*` artifacts no longer carry the rows.
- **Shutdown:** `EventBus.close()` is called from a `uvicorn.Server.handle_exit` override before uvicorn drains connections; the SSE generator waits on the queue and `bus.closing` and ends with `event: shutdown`.
- **Backup/restore:** `config.yaml` gained `backup: hot`, `backup_pre`/`backup_post` (`emhass_lens.backup_pre` checkpoints + `quick_check` + a marker file that travels inside the backup) and `hassio_role: backup`; `StorageService.detect_restore()` (at start) inserts a pinned placeholder run at the highest run number `app.db` references so numbering continues, kv `restore.detected`, rule `restore.recent` until dismissed (`POST /api/storage/restore-ack`); `backup_status()` lists Supervisor backups containing the App's slug (rule `backup.stale`). `docs/BACKUP.md` runbook and `scripts/restore-drill.sh` (unpacks a Supervisor backup tar, starts the App in safe mode on it, prints a report; refuses encrypted archives with advice).
- **Verified:** backend 266 tests (new `test_storage.py`, `test_backup.py`, artifact cap, SSE close), frontend 83 tests, lint/types/build. e2e: see below.

### 2026-10-10 (evening): nothing re-polled after a restart (unreleased)
- **Why:** the owner's 0.3.0 start-up log fetched the eupowerprices.com forecast again ("unchanged") and briefly raised "The price forecast isn't available". `ForecastService.latest` was memory only; the stored snapshots were never loaded back.
- **Done:** `ForecastService.load()` (called from `wiring.build` with `prices.load()`) restores each provider's newest `forecast_snapshot` into `latest` when it still reaches into the future, and the real poll times from kv `forecast.<provider>.polled` (written after every attempt; `fetched_at` only says when the content first appeared and the accuracy view relies on it). `next_ee_poll` then continues from the last success. Audit of the first minute after start: everything else is persistence-aware (Nord Pool per-day state, plan watch by timestamp, measurement backfill by covered range); the EMHASS health/config checks must run (config is in memory) but `poll_health` no longer queues a second config check while the start-up one runs. Settings navigation titles wrap (`.section-nav button { white-space: normal }`); the Measurements title is just "Measurements". Tests: `tests/test_forecast_restore.py`.
- **Fusebox sell power helper removed** from the market controller (settings schema 2 with a migration dropping `market.entities.fusebox_sell_helper`): it mirrored a manual override in the automation that nothing sets, and the owner's history shows no Fusebox sessions. The automation still has the two template lines; they only matter if someone sets the helper.

### 2026-10-10 (later): plan history, accuracy and cost functions (released as 0.3.0)
- **Why:** the owner asked whether the Plan charts could also show the past and how accurate the plan has been, and for a way to compare EMHASS's three cost functions (profit, cost, self-consumption) including each one's total cost-function value, all three on one chart with toggles.
- **History and accuracy (Part A):** `services/measurements.py` reads quarter-hour means from Home Assistant's recorder (`HaClient.history`, REST `/api/history/period`, `domain/measure.py` for the time-weighted means) into `measurement` (migration 0004); `measure.sample` every quarter at :20 s, `measure.backfill` in six-hour chunks newest-first after a start or a settings change, the covered range remembered in kv so slots without data aren't re-asked. `plan_row` keeps the per-slot plan columns of every stored plan (written in `_store_plan`, indexed once at start for older plans) so the accuracy view never decompresses `plan_snapshot`. `domain/accuracy.py`: `pick_snapshot` (the newest plan made at or before slot − lead), MAE/bias/RMSE/MAPE and the sign hint. `GET /api/plan/history?hours&horizon` → `services/history.py`. UI: `HistoryControls`, the charts in `PlanCharts.tsx` draw measured past + current plan as one solid series and "planned at the time" dashed, past region shaded (`--chart-past`); `AccuracyCard`. Settings → Measurements (defaults: PV `sensor.sofar_pv_power_total_watt`, load `sensor.house_power_without_deferrable`, SOC `sensor.ev6_battery_soc` × 0.01; grid and battery empty). Health: `measurements.entity_missing`, `measurements.stale`.
- **Cost functions (Part B):** EMHASS 0.18.5's source confirms `costfun` is a runtime parameter (`associations.csv` row `optim_conf,costfun,costfun`; `set_input_data_dict` reads `optim_conf.costfun`), that every run rewrites `opt_res_latest.csv` and the plan store, and that the result carries `cost_profit` plus one `cost_fun_*` column naming the method. `EmhassMpc.costfun` goes into the payload (never in the parity build); `MpcService._costfun_note` checks the plan's column and `CostfunCompareService.ignored` raises `emhass.costfun_ignored`. `emhass.costfun_compare` (manual, or on every live run with `compare_costfuns`) runs the other two methods then the live one under one `action_lock`, stores `costfun_result` (migration 0005), `domain/mpc/compare.py` computes comparable totals. `GET /api/plan/costfun`; UI `CostfunPanel` (table, quantity selector, per-method toggles, earlier comparisons). `MpcService.run` was split into `build_now` + `send(locked=)`.
- **Verified:** 248 backend tests (new: `test_measure.py`, `test_accuracy.py`, `test_plan_history.py`, `test_costfun.py`, `test_costfun_service.py`; `tests/world.py` fakes the recorder and the cost-function columns), 80 frontend tests, ruff, pyright, lint, build. e2e: see below.
- **Not done / to watch:** the owner's grid and battery power sensors aren't known; set them under Settings → Measurements and check the accuracy card's sign hint after a day. A comparison on every run adds two optimisations before the live plan at :13; move `slot_offset_s` earlier if publishing at :15 gets tight. `test_market_service.py::test_a_session_end_without_a_fresh_plan_falls_back_to_the_safe_state` failed once in a full run and passed on rerun (timing-sensitive; pre-existing).

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
0. **Settings → Measurements:** set the grid and battery power sensors (signs like EMHASS: + import, + discharge) and, after a day, check the accuracy card's sign hint. Press *Compare now* under Plan → Cost functions once to see the three methods.
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
