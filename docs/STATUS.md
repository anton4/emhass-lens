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
| 0. Scaffolding (packaging, settings with history, scheduler, runs, live logs, UI shell, CI) | code done; needs the on-HA checks below |
| 1. Prices, forecasts and PV in shadow mode, plus parity with the HACS integration | backend done; UI in progress |
| 2. EMHASS orchestration (dry run → live, take over / hand back) | backend done (tested against a fake EMHASS); UI pending |
| 3. MQTT entities and the plan-published event | backend done (discovery/commands unit-tested; not yet tried against a real broker) |
| 4. Retire the HACS integration | not started |
| 5. Inverter control in the App (optional) | not started |

## Decisions for the owner (left open on purpose)
- **License:** the repo has no LICENSE file yet (the old repo didn't either). Pick one (MIT is common for HA Apps).
- **ghcr packages:** already public. They inherit the public repo's visibility, and an anonymous pull works.

## Open questions to verify on the real Home Assistant
These come from docs/PLAN.md §10:
1. The deployed EMHASS version (need ≥ 0.17.9 for `/api/v1/plan`, ideally ≥ 0.18.2), and the address the App can reach it on.
2. Whether Server-Sent Events stream through Ingress without buffering. The Logs page falls back to polling if they don't.
3. Whether Mosquitto is installed (needed for Phase 3).
4. Your live tariff values: Võrk 4? Is excise 0.21 c or 0.307 c?
5. The Elektrilevi night window in summer: wall-clock 22–07, or winter-time 23–08?

## Log

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
1. Finish and commit the Phase 1 UI, then add UI for take over / hand back, ML actions and the MQTT status.
2. **On the real HA (needs you):**
   - Add the repo under Settings → Apps → Repositories and install.
   - Check that logs stream through Ingress, settings save, and safe mode works.
   - Set the EMHASS address or let it be discovered, and run "Import from the HACS integration".
   - Watch parity for a week, including the DST change on 2026-10-25.
3. Phase 4: the HACS deprecation release in the old repo. Phase 5 (optional): inverter control.
