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
| 0. Scaffolding (packaging, settings with history, scheduler, runs, live logs, UI shell, CI) | in progress |
| 1. Prices, forecasts and PV in shadow mode, plus parity with the HACS integration | not started |
| 2. EMHASS orchestration (dry run → live, take over / hand back) | not started |
| 3. MQTT entities and the plan-published event | not started |
| 4. Retire the HACS integration | not started |
| 5. Inverter control in the App (optional) | not started |

## Decisions for the owner (left open on purpose)
- **License:** the repo has no LICENSE file yet (the old repo didn't either). Pick one (MIT is common for HA Apps).
- **ghcr packages:** after the first image build, make `emhass-lens-amd64` and `emhass-lens-aarch64` public. Otherwise Home Assistant can't pull them.

## Open questions to verify on the real Home Assistant
These come from docs/PLAN.md §10:
1. The deployed EMHASS version (need ≥ 0.17.9 for `/api/v1/plan`, ideally ≥ 0.18.2), and the address the App can reach it on.
2. Whether Server-Sent Events stream through Ingress without buffering. The Logs page falls back to polling if they don't.
3. Whether Mosquitto is installed (needed for Phase 3).
4. Your live tariff values: Võrk 4? Is excise 0.21 c or 0.307 c?
5. The Elektrilevi night window in summer: wall-clock 22–07, or winter-time 23–08?

## Log
