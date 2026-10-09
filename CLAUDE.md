# EMHASS Lens: notes for coding agents

EMHASS Lens is a Home Assistant App (Supervisor add-on) that drives EMHASS: it builds prices and
forecasts, runs EMHASS MPC every quarter-hour and shows every input, payload, result and log line in
an Ingress web UI. It replaces the HACS integration in anton4/homeassistant-ee-nordpool.

- **Plan:** `docs/PLAN.md` (approved, phased).
- **Progress, open questions and the next step:** `docs/STATUS.md`. Read it first; update it when you finish a step.

## Layout
- `emhass_lens/`: App metadata the Supervisor reads (config.yaml, DOCS.md, CHANGELOG.md, translations). Never put another `config.yaml`/`config.json` anywhere else in the repo.
- `backend/emhass_lens/`: Python 3.14 package (FastAPI, asyncio, pydantic v2, httpx), managed with uv.
  - `core/`: clock, event bus, redaction, slot math
  - `db/`: SQLite plus numbered SQL migrations
  - `logs/`: logging pipeline
  - `settings/`: model, revisions store
  - `scheduler/`
  - `runs/`: run recorder
  - `api/`: routes and response schemas
  - `domain/`: pure price/forecast/MPC logic (Phase 1+)
  - `clients/`: HA, EMHASS, Nord Pool and other HTTP clients
- `frontend/`: React 19 + Vite + TypeScript, TanStack Query, HashRouter.
- `Dockerfile` (repo root, multi-stage), `.github/workflows/{ci,addon-image}.yml`, `scripts/make-local-addon.sh`.

## End-to-end tests
`e2e/` starts a real Home Assistant (optionally with the old HACS integration), Mosquitto and EMHASS in Docker, and checks the whole chain: `cd e2e && ./up.sh && ./check.sh && ./down.sh`. See e2e/README.md.

## Commands
```sh
cd backend && uv sync && uv run pytest -q && uv run ruff check . && uv run ruff format --check . && uv run pyright
cd backend && EMHASS_LENS_DATA_DIR=./data TZ=Europe/Tallinn uv run python -m emhass_lens   # API + UI on :8099
cd frontend && npm ci && npm run dev        # UI on :5173, proxies /api to :8099
cd frontend && npm run typecheck && npm run lint && npm test && npm run build
# after changing API routes or response models:
cd backend && uv run python -m emhass_lens.openapi_dump ../frontend/src/api/openapi.json && cd ../frontend && npm run gen:api
```

## Rules of the codebase
- **Startup and configuration**
  - Nothing reads environment variables or settings at import time. Bootstrap options are loaded once in `__main__`, and everything is wired in `app.py`/`container.py`.
  - Settings live in `settings/model.py`. Every field gets a title, a description where useful, and `json_schema_extra=ui(...)` hints, because the UI renders forms from the schema. Use `Field(default=...)` (keyword), which pyright needs.
- **Time**
  - Anything time-dependent takes a `Clock`, and tests use `FakeClock`.
  - Store and serve timestamps as UTC ISO via `core.clock.iso`.
- **Domain logic** is pure functions (`now` and tz passed in) with no I/O, and is tested with recorded fixtures.
- **Jobs and runs**
  - Every job runs through the scheduler and the run recorder.
  - Attach what the run looked at and produced with `run.artifact(kind, data)`.
  - To stop deliberately, raise `RunRefused("why")`; that is an outcome, not an error.
- **Logging**
  - Use `logging.getLogger("emhass_lens.<component>")`.
  - Never log secrets. The redactor masks known secrets anyway, but don't rely on it.
- **Frontend**
  - All URLs are relative (`./api/...`) because the UI is served under the Ingress path.
  - Types come from the generated `src/api/schema.d.ts`.
  - `package-lock.json` must keep `https://registry.npmjs.org/` URLs, because CI installs from the public registry. If your npm is configured for a private registry, rewrite the URLs back after `npm install`.
- **Commits** use Conventional Commits: `feat|fix|docs|refactor|chore|perf: <imperative summary>` (CI and test-only changes are `chore`), with a bullet-point body and no Co-Authored-By trailer. CI must stay green.
- **Releases:** bump `version` in `emhass_lens/config.yaml` and add a `CHANGELOG.md` entry. That triggers the image build.
