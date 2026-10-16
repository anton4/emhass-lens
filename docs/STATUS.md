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
| 7. Qilowatt market controller in the App | done, released in 0.3.0, experimental: off by default; shadow compares with the automation; live runs the sessions behind one Sofar writer and hands the inverter back to the plan with one write. Go live only after Phase 5 is live. The session watchdog (0.4.24) replaces the HA "Qilowatt: Session Watchdog" |

## Decisions for the owner (left open on purpose)
- **License:** the repo has no LICENSE file yet (the old repo didn't either). Pick one (MIT is common for HA Apps).
- **ghcr packages:** already public. They inherit the public repo's visibility, and an anonymous pull works.

## Open questions to verify on the real Home Assistant
These come from docs/PLAN.md §10:
1. The deployed EMHASS version (need ≥ 0.17.9 for `/api/v1/plan`, ≥ 0.18.2 avoids the grid-boundary waits, 0.18.5 recommended), and the address the App can reach it on.
2. Whether Server-Sent Events stream through Ingress without buffering (the status chip's panel says "Live updates" when they do). If they don't, every page keeps its timers and the Logs page polls `/api/logs` every 5 s (since 0.3.20).
3. Whether Mosquitto is installed (needed for Phase 3).
4. Your live tariff values: Võrk 4? Is excise 0.21 c or 0.307 c?
5. The Elektrilevi night window in summer: wall-clock 22–07, or winter-time 23–08?

## Log

### 2026-10-16 (afternoon): the rest of variant A, step by step (Plan page released in 0.5.0)
- **Why:** the owner asked what of the "EMHASS Lens charts" canvas (https://claude.ai/artifact/4nt7QFTBrbE5bjbHnkoHw6,
  variant A) wasn't built yet, and asked for all of it: the rest of the Plan timeline (A1, the interaction board X),
  the phone (A5), What EMHASS gets (A2), the price breakdown (A4) and the controller day strips (A3).
- **The owner's choices:**
  - a market session's baseline is the grid's mean in the 60 s before its first command, and delivery is judged
    against it (display only);
  - the arrow keys follow the zoom: 10 s (Shift 5 min) at 2 h or less, else a quarter-hour (Shift an hour);
  - the 10-second grid readings are kept for 8 days;
  - `frr*` modes are aFRR and `mfrr*` mFRR.
- **UI checks** run against a mock API that is not committed (`frontend/node_modules/.cache/mock/vite.mock.config.mjs`
  on :5174), which proxies what it doesn't generate to a local backend on :18101. Port 8099 is an SSH tunnel to an
  old dev instance.
- **G1, the plan faded right of now:**
  - TimeChart takes `split` (a moment, the faded side and a wash) and `fade` on series, overlays and gaps. Lines and
    areas get a gradient with a hard edge at the split, drawn on every draw, so the moving now line needs no rebuild.
    Legend swatches and cursor dots keep the series' own colour. `lib/chartFade.ts`.
  - Plan page: the stacked areas, the grid plan, its tail in the slot in progress and the planned SOC are fainter right
    of the now line, on `--chart-ahead`. The past is no longer shaded (`pastShade` is gone).
- **G2, one time axis:**
  - TimeChart takes `timeAxis: 'ticks'` (gridlines, no labels), `axisWidth`, `nowLabel` (a pill on the canvas at the
    now line; the labels within 52 px of it are left out) and `cursorLabel` (a DOM pill at the cursor, from the cursor
    store, so it follows the synced charts too).
  - Plan page: Power, SOC and Price have tick-only axes and are shorter; the MPC runs strip carries the labels,
    "now 14:34" and the cursor's moment ("12:59:58" in the past within 12 h, else "13:00"). Every chart has a hairline
    at each local midnight (`--chart-midnight`).
  - `lib/chartTime.ts`: `localMidnights` (moved from Overview, 900 s steps so 23- and 25-hour days work), `spanLabel`,
    `rangeLabel`, `cursorTimeLabel`, `clearOf`.
- **G3, dots and quieter lines:** `ChartOverlay.dot` puts a dot at the cursor on an overlay (`overlayAt`, a binary
  search over spans sorted once per array); the grid's readings and the commanded line have one. "Planned then" is a
  thin grey dashed line (`--chart-then`) for the grid and the SOC, and the commanded line is dashed black, no halo.
- **G4, the keyboard:** TimeChart's `keyboard` makes the chart a focusable `role="group"`: ← → step the cursor
  (Shift a big step), + − zoom around it, Page Up/Down move the window by half, Home goes back (onZoom(null)), Escape
  puts the cursor away. The cursor is placed with uPlot's `setCursor(…, true, true)`, so the synced charts and their
  popups follow; a step past the edge moves the window. A visually hidden live region reads the values 300 ms after
  the last key (`readoutText`). `lib/chartKeys.ts` (`keyCommand`, `applyKey`, `adaptiveStep`, `keyHint`);
  `zoomAround` and `panBy` came out of `wheelWindow`. On the Plan page only the Power chart is a tab stop.
  - Checked in Chrome: the arrow keys, Shift, +, Page Down and Home, the popups on all four charts, the readout.
- **G5, dragging and touch:**
  - Shift + drag moves the window (a capture-phase mousedown on uPlot's root, before its own select starts;
    `dragPan`).
  - A range drag shows its times in a chip over the plot ("12:00 – 13:23 · 1 h 23 min") on the chart under the
    pointer, and the selection is blue with firm edges. Escape cancels it. uPlot hands a drag to every chart on the
    sync key, and each zooms in its own setSelect hook, so the cancel is a module-level flag, cleared on the window's
    mouseup after uPlot's document mouseup.
  - Touch, through pointer events: one finger reads the values where it is; two fingers pinch to zoom and move
    together to pan (`pinchWindow`). `touch-action: pan-y` on the plot, and Safari's `gesturestart` is prevented.
  - Checked with synthetic events in Chrome (uPlot ignores mousemoves without `movementX`). A real phone through
    Ingress is still to do. The test tab was hidden at times, and rAF then never runs, so popups wait.
- **G6, chart pieces for later steps:** `hatches` (stretches hatched across the plot under the series, each with an
  optional label at its top-left; `--chart-hatch`), `cursorBand` (the cursor as wide as a slot, through `--slot-px`
  set in the setScale and setSize hooks), `ChartNote.look` ('pill', or 'callout': a dark box with a stem down to the
  point) and `top` (pinned to the plot's top), and `toValue` on overlay spans (a straight line from one value to
  another; `overlayRuns`, `overlayExtent` and `overlayAt` follow it).
- **G7, popup pieces:** series take `share` (the row's share of the `total` series), `popupRank` and `rule`; the popup
  takes `lead` (rows right after the lead row), `totalInHead`, `note` (a muted line under the rows) and `style:
  'chip'` with `chip` (a small chip at the top of the cursor line instead of the popup, also on a compact strip).
  `PopupExtra.swatch` (square, line, dash, none) and `PopupBlock.text`/`meter`.
- **G8, refactor:** the Plan page's series builders are pure functions in `lib/planSeries.ts` (`planFlows`,
  `socSeries`, `priceSeries`, `powerSeries`), so the phone layout can share them. The zoom lives in PlanPage and
  `key={view}` is gone: changing the window no longer rebuilds the charts (checked: the same canvas after 24 h → 8 h).
- **P1, the Timeline's header:**
  - An intro over the charts: "Measured until 14:54, every 10-second grid reading from Home Assistant; then the plan
    from run #4554 (14:41). Times in Europe/Tallinn." The cadence is the median gap between the readings
    (`gridCadence`); on a long window it names the means instead (`readingsPhrase`). The time is the last reading
    (`lastReading`), else the history's last sample.
  - Beside Window and Compare, a pressed "Following now" button with a green dot, or "Back to now"; the status bar
    over the charts is gone, and "showing <window>" moved into the Overview's heading.
  - Key hints with `<kbd>` under the charts (`pages/plan/ChartHints.tsx`); their arrow-key step follows the window,
    and on a coarse pointer they are the touch gestures instead.
  - 2 d now runs from 24 h back to the plan's end.
  - While a wider window's history loads, the charts stay at 45 % opacity with `aria-busy`.
  - To feed the intro, the hidden parts and the grid-detail query moved from PowerChart up into PlanCharts.
- **P2, popup wording and the session block:**
  - "Planned then" follows Compare with: "planned 6 h ahead" in the popup's row and the key (`thenLabel`, the then
    series' `popupLabel`, `PopupRow.thenName`).
  - A rule between the grid's rows and the flows (the first row after the lead rows).
  - The heading reads "Fri 16 Oct · 12:49:55 · 10 s reading" (`momentLabel(…, { date: true })`), or "· mean of 2 min"
    on a long window.
  - The session block: "↑ SELL kratt · mfrrup", "9.97 of 10.00 kW delivered (100 %)" with a meter in the
    session's colour (`sessionDelivery`: at the moment where there is a reading, else the command's mean), the
    shortfall row, and the session lines. "Commanded −10.00 kW, since 12:48:40" moved into the rows, after the
    grid's quarter-hour mean and before what was planned (`marketLead`, `popup.lead`).
- **P3, chart heads:** `components/charts/ChartHead.tsx` (title, unit, a key of swatches drawn the way the chart draws
  them, and a summary at the right) on Power, SOC and Price; the SOC and price charts lost uPlot's legend for it.
  - Power: "imported … · exported … · PV … kWh" over the window shown (`lib/planTotals.ts` `energyIn`, slots the
    window cuts counted in part); the chip row gains "grid plan", "sell" and "buy".
  - SOC: measured, planned then, plan (faded), previous plan; "now 56 % · plan reaches 68 %" (`socSummary`).
  - Price: import, export, the ribbon's gradient with its low–high, the forecast; "cheapest 0.048 at Fri 19:00 ·
    dearest …" (`windowExtremes`, `dayTimeLabel`). The ribbon now spans the cheapest to the dearest quarter-hour in
    the window shown (`priceHeatLane(…, window)`). The forecast is hatched with a "forecast" label, and the note
    under the chart is gone.
- **P4, market sessions as drawn:**
  - Bands are a 0.15 tint with a 3 px edge along the top (the side edges are gone); an aFRR session is hatched in its
    colour on a lighter tint (`ChartSession.hatch`).
  - `marketProduct(mode)`: `mfrr*` is mFRR, `frr*`/`afrr*` aFRR (the owner's reading), plain buy/sell none;
    `sessionProduct` when all of a session's commands share one. Flags read "↑ SELL · mFRR · 9.4–11.0 kW", the
    popup block "↑ SELL · mFRR", the lane "sell · mFRR · 9 commands · …".
  - Flags take two rows above the plot, each with a stem down to its session's start: a flag that has no room in the
    first row even at its shortest goes to the second at its longest, and is left out only when neither row has
    room (`layoutFlags` returns `row`). Before, two sells right after a buy pair could lose both flags. The Power
    chart is 23 px taller with sessions.
  - "No market sessions between … and …" in the key when commands are loaded but none falls in the window.
- **P5, MPC runs as blocks:** each run is a block from its start until the next one starts (at most a quarter-hour),
  in its outcome's colour, and the next scheduled run is an outlined box (`lib/runBlocks.ts`; `ChartTick.until` and
  `outline`). A chip at the cursor names the run ("run #4522 · OK", `popup.style: 'chip'`) instead of the browser's
  tooltip, and a click anywhere in a block opens it. The counts and "Next MPC" moved into the strip's head.
- **P6, the overview:**
  - The grid's line is solid where it was measured and dashed where it is the plan (`lib/overview.ts`
    `overviewPaths`).
  - Sessions are 3 px ticks at their start.
  - A day gets its name every second day when a day has under 70 px (`dayLabelEvery`).
  - The brush has three looks (`data-state` idle, handle, drag; `brushState`): empty, filled when pointed at with that
    edge's handle grown, and a firmer edge with a glow while dragged, with a chip naming the window ("Fri 14:45 → Sat
    20:17 · 8.2 days").
  - `aria-valuetext` carries the same text.
  - The heading reads "Overview · grid power and market sessions, Fri 9 Oct to Sat 17 Oct … showing … (8.2 days)".
  - Overview takes `left` (the charts' y-axis width) for the phone.
- **P7, a stale plan and missing readings:**
  - Backend: `PlanResponse.stale_after_s` = 900 × Settings → Health → Plan is stale after (default 2 slots), asserted
    in `test_live_mpc_sends_payload_and_verifies_the_plan`.
  - The Plan page says "Plan is 67 min old: the last MPC success was 14:07:37. The plan ahead is hatched until a run
    succeeds." (`planAge`, `staleNote`; EMHASS keeps serving its last good plan, so the plan's time is the last
    success). The plan ahead is hatched with "plan too old" on Power and SOC.
  - The grid's missing readings (null points of a minute or more, back-to-back ones joined; `missingStretches`) are
    hatched with "no readings", and named under the Power chart ("11:34 – 12:09: no grid readings in Home
    Assistant's history"). An unavailable sensor and an empty recorder can't be told apart, so the text says
    neither.
- **P8, the table around the cursor:** the Chart/Table toggle is gone. Under the charts, "Table view: the 6 hours
  around the cursor" lists 24 quarter-hours (grid, PV, house, battery + charge, SOC, import, export), measured left of
  now and the plan right of it, the cursor's row marked (`lib/planTable.ts` `tableAround`; no Inverter column: there
  is no per-slot mode for the plan). It follows the Power chart's cursor through `TimeChart.onCursor` and a value
  store (`createValueStore`), so the charts don't re-render with it, and it is only worked out while open; it stays
  on the last cursor after the pointer leaves. The full EMHASS table is the second collapsible, "Every column of this
  plan".
- **P9, a baseline for market sessions** (the owner's choice):
  - Setting Market → Thresholds → Baseline, `baseline_s` (default 60 s, 0–900, advanced; no schema bump, a default
    fills it in).
  - Backend: `domain/market.session_starts` (back-to-back spans of one direction are one session, as the Plan page
    groups them); `GridDetailService.baselines(starts, window_s)` (the grid's time-weighted mean before each start
    within 48 h, from the hours it already holds; `bucket_means`); `MarketCommandSpan.baseline_w`. Tests:
    `test_a_session_gets_the_grid_mean_before_it_as_its_baseline` (500 W before the 08:45:12 sell, none at 0 s) and
    `test_back_to_back_commands_of_one_direction_share_their_session_start`.
  - Frontend:
    - `commandTarget` = baseline − a sell's power (+ a buy's), which the commanded line now draws.
    - `deliveredW`, `sessionDelivery` and `shortfalls` all count from the baseline.
    - The popup's rows read "commanded target, since …" and "baseline, before the session".
    - Display only: the controller keeps writing the command's absolute target.
  - With the mock's baseline of 2.44 kW exported, the same −6.85 kW reads 4.41 of 10.40 kW delivered (42 %), where
    from zero it read 66 %.
- **P10, a week of 10-second readings** (the owner's choice):
  - `services/grid_detail.py` keeps 8 days (`MAX_HOURS` 194, about 1 MB for a 10 s sensor) and serves them
    (`WINDOW_MAX`, the route's `GRID_DETAIL_MAX`).
  - Missing hours are read newest first in 6 h requests, the lock taken per request so the live refresh isn't held
    up behind a long read.
  - A chart request reads at most 12 settled hours (`REQUEST_HOURS`) and returns `pending: true` for the rest.
  - The new `measure.grid_warm` job (Dynamic, recorded) reads 24 h per run until the week is in memory, after a
    start, a new grid sensor (`measurements.grid` subscription), or a request that found hours missing.
  - `delivered()` and the baselines now reach 8 days back.
  - Frontend: `DETAIL_MAX_S` is 8 days, and the detail query refetches every 3 s while `pending`. The point budget
    stays at 3000, already more than the pixels; each bucket's lowest and highest reading keeps every spike.
  - Tests:
    - `test_a_long_window_reads_the_newest_hours_first_and_the_warm_up_job_the_rest`: 06:00–now then 00:00–06:00,
      pending, then the job until "The grid's readings for the last 8 days are in memory", no longer pending.
    - `test_the_delivered_power_covers_the_week_and_skips_older_commands`.
  - **Not checked:** the warm-up against the real recorder, and how long its reads take there.
- **P11, release 0.5.0** (the Plan page: 44d8fe1 and G1–P10): config.yaml, CHANGELOG.md and DOCS.md ("Plan history
  and accuracy" rewritten for the new page). The e2e stack passed 25/25 (backend 471 tests, frontend 374).
  - **Not done:** the README screenshots. They show live data and have to be taken from the App
    (`uv run scripts/readme_screenshots.py --base <the App's direct port>`); the SSH tunnel on 8099 is an old dev
    instance.
- **M1, the Plan timeline on a phone** (A5), below 640 px (`useMediaQuery`):
  - Windows: a 4 h window (3 h back, 1 ahead) as the phone's own, and three full-width buttons (4 h, 24 h, 2 days).
    A window chosen on the other layout maps across (`viewFor`: 8 h ↔ 4 h, 7 d → 2 days). Compare with is hidden
    and the phone compares with the plan in force.
  - The head reads "Timeline Fri 16 Oct · now 15:37" with Following now.
  - Charts: **Grid** (`PowerChart phone`: the grid line, readings, sessions, shortfalls; "↓ 0.0 · ↑ 7.2 kWh"),
    **Power balance** (`balanceSeries`: the grid stacked as a layer, import on top and export at the bottom;
    `powerStack({ grid })`), **State of charge** ("now 56 %") and **Import price** (with its ribbon and the time
    axis, "now" on it). No MPC strip; the intro line and the chips' toggle row are left out.
  - Every chart has a 30 px axis with short ticks ("5", ".10") and a chip at the cursor in place of the popup
    (`PopupChip.swatch`, lines stacked). Chips show on every synced chart: the docked-popup rule now applies to
    popups only. Lane names leave the gutter when it has no room.
  - The overview reads "Overview, 2 days" and the hints are the touch ones.
  - `.chart-stack` gets `minmax(0, 1fr)`, so the charts follow the width down instead of holding the column at a
    canvas's old width.
  - Checked in Chrome in a 390 and a 360 px frame (no side scroll at either), hovering the Grid chart for the chips
    on all four.
  - **Not checked:** dark mode, a real phone through Ingress (touch, pinch).
- **M2, release 0.5.1** (the phone layout): config.yaml, CHANGELOG.md, DOCS.md.
- **I1, where the deferrable loads may start, and the SOC limits** (backend):
  - `domain/mpc/sent.deferrables(…, emhass_config)` gives each load `start_timesteps` and `start_source`: the
    payload's `start_timesteps_of_each_deferrable_load` (or the old `def_start_timestep`) when it has them, else
    EMHASS's config (EMHASS Lens doesn't send one; a start can only come in through Extra runtime parameters).
  - `soc_limits(payload, emhass_config)`: `battery_minimum/maximum_state_of_charge`, payload first.
  - `SentInputs.soc_min`/`soc_max`; EMHASS's config as it is now, not as it was for an old run.
  - Tests: `test_where_a_load_may_start_comes_from_the_payload_else_emhass_config`,
    `test_the_soc_limits_come_from_the_payload_else_emhass_config`, and the live run's 0.05–1.0 with start 0 from
    EMHASS's config.
- **I2, the tariff's parts beside the prices** (backend): `domain/tariffs/engine.tariff_summary` (the package's name,
  the fees, the network rates it resolves to through `network_rates`, the night window, VAT, the export fees) as
  `PricesResponse.tariff` (`PriceTariff`). Tests: `test_the_tariff_summary_names_the_fees_and_the_rates_the_package_resolves_to`
  and `/api/prices` carries VAT 24 % and 22:00–07:00.
- **I3, tiles and chart heads on What EMHASS gets:**
  - The tiles are `pages/inputs/Tile.tsx`, with the quantity's colour before the name; `Breakable` moved there too.
  - Each chart has a `ChartHead`: title, unit ("€/kWh, fees and VAT included", "kW · Solcast, 7 day sensors", "kW ·
    EMHASS's own ML forecast, not sent", or "House load sent" when it was), a key, and the payload keys at the right.
    This comes from `lib/sent.ts` `sentHeads`, tested.
  - uPlot's legends are off.
  - A footnote under the charts carries the export cap (moved out of Details).
  - The mock API got a generated `/api/inputs/sent` (24 h measured, about 30 h sent, an EV window starting at slot
    8, two days after the horizon); `/api/prices` comes from the local backend's real Nord Pool fetch.
- **I4, the tariff and the export cap in colour:** `lib/prices.ts` `PERIOD_STYLES` and `periodLane` (runs of one
  period, night in `--tariff-night` violet, the day neutral, peaks amber, "night network tariff" with `long`);
  `tariffLane` uses it. The export lane is green where EMHASS may export and red, hatched in `--q-export-cap`, where
  it is capped at 0 W; the popup's row follows.
- **I5, forecasts, the EV's window, PV day totals:**
  - **Prices:** forecast prices are hatched, with "forecast from Sat 00:30" on a pill at the top (`forecastNote`).
    The popup's tariff and export rows became one note line: "Night tariff · export limit 0 W (export price at or
    below 0.04 €/kWh) · forecast price" (`priceNote`, `popup.note`).
  - **The EV's window** is hatched across the house load chart from its first allowed timestep (I1) to its
    deadline, named on a pill: "EV · 11.00 kW for 2.5 h, Fri 17:30–00:00", or "…, by …" when it may start at once
    (`windowBands`, `windowNotes`; `loadWindow` honours `start_timesteps`). The lane under the chart is gone, and
    the tile reads "…, window Fri 17:30–00:00".
  - The house load is an area.
  - **PV:** each day's total is on a pill with its weekday ("Sat · 24.8 kWh", `PvDay.day`).
- **I6, the battery's limits and path, the anchor on every chart:**
  - **Battery:** `soc_min` and `soc_max` (I1) are dotted across the chart, and a line runs from `soc_init` at the
    anchor to `soc_final` at the end of the horizon, both named on pills ("soc_init 47 %"); `socOverlays`,
    `socNotes`, token `--q-soc-ink`. The popup has one row "soc_init → soc_final · 47 → 100 %" and the limits as
    its note (`socExtras`, `socNote`).
  - **The anchor** replaces the now line on all four charts. Only the battery chart has time labels, with an
    "anchor 15:30" pill; the cursor is a slot-wide band.
  - The unused `priceExtras` is gone (its rows became `priceNote` in I5).
- **I7, arrow keys and a faded past:**
  - The prices chart takes the keys: ← → step a slot, ⇧ an hour, + − zoom, Home goes back to the whole payload
    with the cursor on the anchor (fixed steps: the charts snap to slots). The footnote and the chart's label say so.
  - Before the anchor the prices, PV and house load are drawn at 0.55 without their fills (`split` at the anchor).
  - **Fix (TimeChart):** uPlot commits a new window in a microtask per chart, so after Home from a zoomed window
    the cursor landed elsewhere and the synced charts read the slot before. The `setScale` hook now places it
    again once every chart has the window (seen on Inputs; the Plan page's Home had the same bug).

### 2026-10-16: the charts' variant A: power in one chart, every 10-second grid reading, a popup per chart (0.5.0)
- **Why:** the owner found the charts hard to read, reviewed two mockup directions and picked A ("Flight deck", light),
  with every value in a popup per chart and the grid's 10-second readings shown by default.
- **Backend:** when the grid detail has to average, each mean carries its bucket's lowest and highest reading
  (`GridPoint.lo`/`hi`; `domain/measure.detail` returns the bounds); `max_points` goes up to 6000.
- **Plan timeline:**
  - **Power** is one chart: PV and the battery discharging stacked above zero; the house load, the battery charging and
    the deferrable loads below (`lib/powerStack.ts`). The grid is a line on top: every reading left of now, drawn
    through each bucket's lowest and highest reading on a long window, and the plan right of it. Battery, PV and house
    are no longer separate lines with "planned then" twins; the grid keeps its.
  - **Window** (8 h, 24 h, 2 d, 7 d around now) replaces History (`VIEW_WINDOWS`, pref `emhass-lens.plan.view-window`).
    The charts follow now until a zoom, a scroll or the overview picks a window; "Back to now" or a double-click
    returns.
  - Scrolling zooms around the pointer; Shift or a sideways scroll pans (`wheelWindow`). An overview strip under the
    charts shows everything loaded with a brush to drag or resize (`components/charts/Overview.tsx`).
  - **Popups:** one value per row, value first; "planned then", the quarter-hour's mean and the readings' range on rows
    of their own. They read the quarter-hour the pointer is in (they took the nearest slot start before).
  - **Price:** a ribbon of the import price in seven violet steps under the chart (`priceHeatLane`).
  - The axes use Geist.
- **Colours:** import violet and export green, two hues instead of two violets. The price breakdown is spot, network,
  fees, VAT from the bottom in blue, aqua, yellow, magenta; the order changed so neighbours pass the colour-vision
  check in both themes.
- **Price breakdown:** each day's cheapest and dearest quarter-hour is named over its column; the fees chip is "Fees"
  with the parts in its tooltip.
- **Day strips:** taller, an hourly axis with a label every 3 h, and now's time on it.
- **Checked:** backend 468 tests, ruff, pyright; frontend typecheck, lint, 289 tests and the build. The Plan and Inputs
  pages were looked at in Chrome against a mock API with simulated 10-second readings and a sell session.
  - **Not checked:** a real Home Assistant, and the controller pages' day strips in a browser.

### 2026-10-15: MPC keeps planning during a market session (unreleased)
- **Why:** HA raised "No successful MPC run recently: last success 2026-10-15T05:56:05.406689+00:00" about 40 min
  into a market session.
  - Held runs were built but not sent, so the last success went stale.
  - Worse, after any session over `plan_max_age_slots` (30 min) the hand-back had no plan young enough:
    `InverterService.apply` refuses "The plan is stale", and Live market control falls back to the safe state.
  - Nothing written down said why MPC mustn't be sent during a session. The hold's reasons are all about inverter
    writes, and those stay held.
- **services/mpc.py:**
  - `run()` sends during a hold as well. An `ok` run says "not published while a market session holds the
    inverter (…)".
  - No ML fit starts after a run during a session (it would block the runs and the re-plan at the end).
  - Cost-function comparisons stay refused during a hold.
  - Publish, the inverter decision and the catch-up stay held.
- **services/health_rules.py:**
  - `mpc.stale` counts during sessions again (49f540f had skipped it).
  - Its detail and `backup.stale`'s date are in local time via `_when` ("08:56", or "Wed 14 Oct 08:56").
- **Wording:**
  - the hold and re-plan setting descriptions;
  - external.py's docstring and log line;
  - the Plan page's market tooltip (planNow.ts);
  - DOCS.md "During a market session";
  - PLAN.md's Phase 5c row.
- **Publishing during a session too:** looked at and left held. A publish chains the EV charger's EMHASS decision
  and fires `emhass_lens_plan_published`, and EMHASS's `p_deferrable*` sensors drive loads in HA. The plan doesn't
  know about the session, so it could start the car or a deferrable load during a sell and eat into the power owed
  to the aggregator.
- **Checked:** 467 backend tests, ruff, pyright, and on the frontend typecheck, lint and 268 tests.
  - New: `test_a_long_session_hands_back_to_a_plan_made_during_it`. It fails with the old send rule: the hand-back
    decision is `noop`.
  - **Not checked:** a real session.

### 2026-10-14: a market gap inside the deadband is written once it holds for the cooldown (0.4.39)
- **Why:** the owner asked why this morning's Kratt sell didn't get full power (runs 5627–5658, 08:45:54–09:04:04).
  - Kratt raised the frrup sell from 9400 W to 10600 W at 08:48:53, and the grid register stayed at -9400 W.
  - The 1200 W change was inside the deadband max(300 W, 15 % × 10600 W) = 1590 W. The cooldown was over a minute
    later, but every minute tick said "within the deadband: nothing to write".
  - At 08:59:14 Kratt dropped to 9500 W (100 W off). In all the grid missed about 0.21 kWh.
  - The rule comes from the HA automation: on a steady command it holds a gap of up to 15 % for the rest of the
    session.
- **The owner's choice:** keep the 15 % against quick jitter, but write a gap of more than `deadband_w` once it has
  held for `cooldown_s`. Two other options were turned down: setting `deadband_pct` to 0, and changing its default.
- **domain/market.py:**
  - `MarketInputs.gap_for_s`. `decide()` uses `deadband_w` instead of the proportional deadband when the delta lies
    between the two and the gap has held ≥ `cooldown_s` (`Throttle.gap_held`, `gap_for_s`).
  - The reasons say "gap held 22 s < 180 s: written at 180 s if it stays" or "gap held 202 s ≥ 180 s: deadband
    300 W".
  - `MarketDecision.parity_needs_update` is the automation's call, and `expected_after` judges by it, so shadow mode
    still predicts the automation.
- **services/market.py:** `_track_gap` keeps `_gap_since` in memory.
  - An open gap (buy or sell, no write, delta > `deadband_w`) starts the gap clock; a write, a closed gap or an end
    clears it.
  - A restart starts the clock again, which costs at most one more cooldown.
- **Replay of this morning:** -10600 W would have gone out at the 08:52:15 tick and -9500 W at 09:02:15. That is two
  more apply presses, with about 0.07 kWh under and 0.05 kWh over instead of 0.21 kWh under.
- **Also:** `deadband_pct` has a description, the Market page's deadband guard names the rule, and DOCS.md too.
- **Checked:** 464 backend tests, ruff, pyright, and on the frontend typecheck, lint, 259 tests and the build.
  - New tests: `test_a_gap_the_deadband_hides_is_written_once_it_holds_for_the_cooldown` (this morning's numbers),
    and the live `test_a_live_gap_inside_the_deadband_is_written_once_it_holds_for_the_cooldown`.
  - **Not checked:** a real Kratt session.

### 2026-10-14: market sessions on the Power chart, one grid line (0.4.38)
- **Why:** the owner found the commands hard to read: a grey dotted line rising from zero, a lane with one pale
  block per command, and a popup listing every command in the quarter-hour. They picked direction A ("Commanded vs
  delivered") from the mockup canvas https://claude.ai/artifact/SdeNh5SupqxXvQjgXaKZ7Y, and asked to:
  - drop "(+ charge)" and "(+ import)" from the chips;
  - draw the grid and its 10 s detail as one line;
  - show the pointer's time in the popup's header instead of after Grid measured.
- **lib/market.ts:**
  - `commandSessions` groups back-to-back spans in one direction, with the delivered share of the energy asked
    (each span's measured mean, capped at its power).
  - `shortfalls(spans, detail)`: the detail's buckets where the grid missed a command by more than max(500 W, 10 %)
    for 60 s or more, merged into runs. `shortfallGap` hatches them.
  - Other helpers:
    - `sessionBands` (flags: "↓ SELL 5.2–9.4 kW", and the detail on hover);
    - `marketLane` (a bar per session: "95 %", or `long` where it fits, plus shortfall marks);
    - `sessionWindow` (zoom with a margin, in whole quarter-hours);
    - `marketBlock` (the popup block).
  - `marketOverlay` is a solid ink line (`--q-market`) with a halo, `base: 'none'`. `marketRows` is gone.
- **TimeChart:**
  - `sessions` are drawn in `drawClear` as tinted bands, and as flags in a 26 px top padding (`lib/chartFlags.ts`
    `layoutFlags` shortens the wider of two flags that touch).
  - Lane spans take `ink`, `long`, `marks` and `id`. Clicks on flags and lane spans go to `onSession`; the listener
    is on the uPlot wrapper, because its axis divs cover the lane.
  - `gaps` are drawn hatched; overlays take `halo`.
  - While the pointer is in a session, `series.alpha` is 0.3.
  - The y fit takes the overlays in `xRange` rather than `u.scales.x`, which is stale during a rebuild. Before this,
    a chip toggled while zoomed left the axis fitted to the whole range.
- **Popup:**
  - `popup.head(t, time)` replaces the slot in the header; the slot then heads the rows ("Quarter-hour
    11:30–11:45").
  - `popup.block` is a tinted `PopupBlock` above the rows.
  - `chartPopup.momentLabel` and `slotRange(…, weekday=false)`.
- **PowerChart:**
  - The grid's measured quarter-hours the detail covers are `null` in `values` and kept in `readout`
    (`gridDetail.withoutCovered`), so the 1.5 px detail line is the grid there.
  - The `grid-detail` chip is gone; the Grid chip's title says how fine the line is.
  - Market chips: *Commanded* ('market-power') and *Sessions* ('market-commands'), after a "Market" group label.
  - New tokens `--q-sell`, `--q-buy`, `--q-*-ink` and `--q-shortfall`.
- **Checked:**
  - typecheck, lint, 259 tests and the build pass.
  - **UI:** the SSH tunnel to the real App dropped, so this ran against a throwaway Vite config with a generated API
    (in node_modules/.cache, not committed). It had a Kratt sell of 24 commands with a 5½-minute shortfall and a
    Fusebox buy. Checked:
    - the flags (both fit, the hovered one expanded) and the fading;
    - the popup (pointer time, block, shortfall row, quarter-hour rows);
    - click to zoom (10:45–12:00 at 10 s, hatched shortfall, lane "sell · 24 commands · 95 % delivered");
    - chips toggled while zoomed.
  - **Not checked:** the real HA, dark mode and phone width.

### 2026-10-14: the measured grid power beside the market commands, and no more P10 (0.4.37)
- **Why:** the owner couldn't compare the market's commands (at their own times) with the power sent to the grid,
  which the Power chart had only as 15-minute means. They chose a grid-only line whose step follows the window, with
  every command start, end and power change as a point and every sensor change once zoomed in, plus the delivered
  power in the lane and popup. They also asked to drop Solcast's P10 from the *PV sent* chart and from what EMHASS
  gets, keeping *Estimate*.
- **Grid detail (backend):**
  - `domain/measure.py`:
    - `bucket_means` (`slot_means` now sits on it), `clip_points` and `step_points`;
    - `pick_step` (10 s … 15 min for at most `max_points`) and `detail_edges` (epoch-aligned steps plus the breaks, a
      step edge within a quarter step of a break giving way);
    - `detail`: raw changes when they fit, else bucket means.
  - `services/grid_detail.py` `GridDetailService`:
    - reads the `measurements.grid` sensor's history in hour chunks kept in memory (72 h at most, as `array('d')`);
    - an hour is complete 2 min after it ends, and the current one is read again after 30 s;
    - missing hours are read at most 6 h per request;
    - `detail()` breaks the line at `MarketService.spans()` (split out of `commands()`).
  - `delivered(spans)` gives the mean and coverage for spans of at least 5 s that ended within 48 h, within a 10 s
    timeout. `MeasuredPower.to_emhass` applies scale and sign (`plan_now` and `measurements` use it too).
  - `GET /api/measurements/grid?since&until&max_points`: until is clipped to now and the window to 48 h, with 400
    when empty. `MarketCommandSpan` adds `measured_w`/`measured_coverage`, `MarketCommands` adds `measured_error`.
- **Grid detail (frontend):**
  - `ChartOverlay.base: 'none'` and the pure `overlayRuns`.
  - Overlays are out of TimeChart's `specKey`: they change by redraw, not rebuild.
  - `CursorAt.time` (the pointer's time) goes to `popup.extra(t, time)`; extra rows are keyed by index.
  - `lib/gridDetail.ts`:
    - `detailRequest` covers the measured part of the zoom or axis, hour-floored when unzoomed, and at most the
      last 48 h;
    - `gridOverlay` and `gridRows`;
    - `gridDetailLabel` for the chip ("Grid every 10 s", "Grid, each change").
  - `lib/market.ts`: `deliveredW`; the lane gets "· got"; `marketRows` gets a *Delivered* row (% of the command,
    *data %* below 90 % coverage, *so far* while open). The Power chart now lists the commands of the pointer's own
    quarter-hour, not of the popup's slot.
    - **Why:** PowerChart has no `snapToSlot`, so the popup's slot is the nearest one on the grid.
    - **Known gap:** from the MPC run at :11 to the end of the quarter-hour, the current slot is in neither the
      history nor the new plan, so the popup names the next slot. This predates 0.4.37.
  - `PowerChart`: a `grid-detail` chip (thin swatch) when the history has measured grid. `useGridDetail` keeps the
    previous data while loading and refetches every 60 s while live.
- **P10 removed:**
  - The payload, `pv_solcast` (`p10_watts`, `p10_series`), the validate length check, the EMHASS "PV P10 blend"
    check, `ExplainSlot`/`BeyondSlot.pv_p10_w`, SentPanel's P10 series/totals/Details, `pvDays`/`pvNotes` and
    ExplainTable's column.
  - `pv.send_p10` is gone with settings schema 7 (`_v6_to_v7`).
- **Checked:**
  - **e2e:** 25/25 on a fresh stack. The new check posts a meter and a sell command, and expects the delivered mean
    and the raw points; the P10 check now expects no P10.
  - **UI:** against the e2e HA with a meter fed every 3 s and sell commands (6 kW, then 4 kW).
    - Zoomed to 13:45–14:30, the thin line steps with the dotted command line: the 6 s ramp and the 6 → 4 kW change
      are visible.
    - The chip reads "Grid, each change".
    - The popup shows *Grid measured +350 W at 14:03:43* and a *Delivered* row per command: 4.90 kW · 98 %,
      5.77 kW · 96 %, 3.99 kW · 100 %.
    - Inputs and Settings show no P10.
    - 390 px wasn't checked: the window wouldn't resize.

### 2026-10-14: the forecasts after the horizon, and the plan length on the Inputs page (0.4.36)
- **Why:** the owner wanted to see how far the eupowerprices and Solcast forecasts reach beyond what is sent, and to
  pick the plan length from there. They chose days after Nord Pool (`forecast.extend_days`), and a switch on the
  charts that saves after a confirm.
- **Backend:**
  - `PriceService.stitched/priced(…, extend_days=)` and `derive(settings, extend_days=)` take overrides.
  - `SentInputsService._ahead` stitches from the anchor with 7 forecast days. Starting the stitch after Nord Pool's
    end would drop the forecast, because it hangs off `actual_end`.
  - It returns `beyond` (the priced slots after the payload's end, with Solcast PV and P10, missing as None) and
    `horizon_options`. For N = 1..7, `end = min(actual_end + N d, the end of the contiguous priced slots,
    anchor + max_horizon)`, `num_lags` comes from `derive`, and `short` is true when it ends early. There are no
    options without a forecast.
  - `GET /api/inputs/sent` and its preview take `beyond`.
- **Frontend:**
  - `SentAxis` gains `beyondIdx` and `axisEndS`; `endS` stays the plan's end. `onAxis` takes a beyond array.
    `tariffLane`, `forecastRangesOn` and `priceExtras` cover the slots after the horizon, and `pvDays` gives
    `notSent`.
  - `horizonLane(axis, data, preview)`.
  - SentPanel has the *After the horizon* switch (pref `emhass-lens.inputs.after-horizon`) and *Plan length*
    (`useSetExtendDays`, ConfirmDialog).
  - `TimeChart.drawNotes` drops a note's sub-text, and then the note, where it would overlap the one before.
- **Checked:**
  - The e2e stack passed 24/24, then got 5 days of eupowerprices points seeded into app.db, with Lens on port
    18101. Port 8099 was taken by an ssh tunnel to the real HA host.
  - The beyond prices, PV and Horizon lane show. Hovering 3 d previews "Nord Pool + 3 d · 340 slots", and 6–7 d are
    disabled once the forecast ends.
  - Confirming saved revision 20 (extend_days 3), and a preview then built 339 slots.
  - At 390 px there is no side scroll, and the PV labels no longer overlap.

### 2026-10-14: a steadier slot headline, market commands on the Power chart, less text (0.4.35)
- **Why:** the owner's screenshot read "Charging the battery from PV and the grid" while PV 3.80 kW − house 389 W
  already covered the 3.44 kW charge (the grid's 145 W ran the house). They also asked for the market's commands
  and powers on the Plan page's Power chart with on/off switches, and for less text across the pages.
- **Headline** (`flowHeadline`, lib/slotFlow.ts): a source is named by power balance (PV covers the house first; the
  grid charges the battery only with what PV's surplus doesn't cover) and only when it adds ≥ `POWER_W` (300 W).
  `steadyHeadline` changes the shown line only after two reads in a row (ThisSlot, keyed on `fetchedAt`, reset per
  slot and after a 30 s gap). The owner chose this over "the plan's intent as the headline".
- **Market on the Power chart:**
  - `command_spans` (domain/market.py) folds the recorder history of `sensor.qw_source` / `qw_mode` /
    `qw_powerlimit` into spans with the same test `decide` uses (known source, buy/sell mode, power > 0 after
    `round100`); `GET /api/market/commands?since&until` (≤ 8 days) serves them via `MarketService.commands`. It
    covers Live, Shadow, the automation and off alike. Recorder errors come back as `error`, and the chart just
    leaves the layer out.
  - TimeChart takes `overlays` (step lines at their own times, off the slot grid, counted in the y fit); lib/market.ts
    has `marketOverlay`, `marketLane` and `marketRows` (popup). Open spans run on to the now line.
  - PlanCharts: `PowerChart` with `legend={false}` and `legend-toggle` chips for every quantity plus Market power and
    Market commands, hidden set in localStorage `emhass-lens.plan.power.hidden`.
- **Less text:** repeats removed and explanations folded (`details.more` or `title`) on Plan, Inputs, the three
  controller pages, Health, Runs and Settings; Settings help over 40 words shows its first sentence (`splitHelp`,
  `FieldHelp`). The mode explain line hides in live (the amber notice says it), and `ConfirmDialog` still shows it.
- **Checked:** e2e stack 24/24. In the UI against the e2e Home Assistant: commands set through its REST API show as
  the dotted line and the lane at their exact times (zoomed), the chips hide/show and survive a reload, the folded
  rules and the Settings *more* links render.

### 2026-10-14: the market's inverter writes beside the plan's (0.4.34)
- **Why:** the owner downloaded `inverter.decide` runs 5603–5667 and asked whether the feed-in button was pressed
  around 08:30, and why the market's writes weren't among them.
  - The 08:30 run (5613) pressed only the apply button; the feed-in limit was already 15500 W.
  - The market writes through the same `SofarWriter`, but as `market.reconcile` runs, so the strip showed the 08:45
    slot as the plan's Self-use. In fact EMHASS Lens's own sell session held Force discharge −9400 W from about 08:45
    to 09:04.
- **Backend:**
  - `GET /api/inverter` adds `writes`: `sofar_commit` for the last 24 h, with owner plan | market. Presses add
    `owner` from the commit with the same run.
  - `GET /api/market/sessions` adds `start_run_id` and `end_run_id`.
  - `GET /api/runs?wrote=inverter` keeps the runs with a `sofar_commit` row, through `recorder.list(ids=…)`.
- **Frontend:**
  - `inverterStrip(rows, sessions, writes, now)` turns a slot a session overlaps into *Market sell/buy*: the state's
    tone with a `--market-stripe`, and `runId` the market's write or the session's start. It also adds slots without
    a decide run.
  - `SlotDetail` carries `market` and `writes`, which `InverterSlotPopup` lists. `pressWho` says *for the plan* or
    *for a market session*.
  - The Inverter page has an **Inverter writes** button, and the Runs page has a **Wrote to the inverter** checkbox.
- **Checked:** the e2e stack passed 24/24. The UI was checked with a session and writes added to its app.db: the
  strip, popup, legend and Runs filter, and no side scroll at 390 px. The live session path is covered by
  `test_live_runs_a_session_throttles_writes_and_hands_the_inverter_back_to_the_plan`.

### 2026-10-14: past prices on *Prices sent*, and the Plan page says what drives the inverter (0.4.33)
- **Why:** the owner asked why *Prices sent* (Inputs → What EMHASS gets) was empty before the anchor with
  *24 h measured* on, and asked the Plan page to say whether EMHASS or a market session is in charge.
- **Prices before the anchor:** nothing is sent for past slots, so the `measured` rows had only load, PV and SoC.
  `MeasuredSlot` adds `load_cost`, `prod_price` and `period`: the stored Nord Pool prices through `PriceService.priced`
  with today's tariff, rounded to `PRICE_DECIMALS` like the payload. The chart draws Import and Export back to the
  start of the axis, and the Tariff lane (`tariffLane`, via `runsOf(…, 0)`) and the popup do too. The Export lane stays
  payload-only (`maximum_power_to_grid` is a payload key).
- **Mode:** `GET /api/plan/now` adds `control` (`control_now` in services/plan_now.py):
  - `market`/`app` while live market control has an open session;
  - `market`/`automation` while the hold is busy, with the command power and source when market control is on;
  - otherwise `emhass`.
  - `watched` is false when neither market control nor the hold is on, because EMHASS Lens can't see sessions then.
  - The Plan page shows it as the first fact: an amber *Market · sell 5.00 kW (kratt) since 10:12* linking to the
    Market page, a green *EMHASS*, or *EMHASS · market not watched*. The hover text explains it (`controlFact` in
    lib/planNow.ts).
- **Checked:** e2e stack 24/24. In the UI, past prices, the tariff and the popup show before the anchor. The Mode fact
  shows both states (the hold on, the session select set to sell), and there is no side scroll at 390 px.

### 2026-10-13: a more compact top of the Plan page (0.4.32)
- **Why:** the owner found the facts row and the *This slot* head two rows too many, *Made for* and *Times in* not
  worth a place, and the flow centred with the SoC and prices far off at the right edge.
- **Head:** PlanPage passes its facts `<dl>` (Planned at, Solve took, Horizon, Total cost function) to `NowSlot`
  (`facts` prop), which shows it in its `panel-head plan-head` beside the slot switch; the slot title is a
  visually-hidden `h2`. The slot's times, published and read go to `ThisSlot`'s line under the headline (`when` prop;
  the line is now parts joined with " · "), or into the no-plan message.
- **Driver:** a plan whose `driver` isn't `app` gets a notice above (amber for `external` with EXTERNAL_PLAN_NOTE,
  blue for `legacy`) instead of the *Made for* fact.
- **Layout:** `.flow` is left-aligned; from 1180 px the slot body is `minmax(0, 720px) 300px` (720 = WIDE_FLOW.width),
  so the side column sits 48 px after the flow. Checked on the e2e stack at 390, 900 and 1190 px: no side scroll.

### 2026-10-13: the Plan page's EV box shows how old its value is (0.4.31)
- **Why:** the owner noticed the EV box was the only one in *This slot* without the age in its top-right corner.
- **Change:** `charger_now` (services/plan_now.py) adds `entity` and `age_s`: the newest `last_updated` of the
  charging-state sensor and, while charging (state 4), the current-limit number, which is what `power_w` follows.
  The frontend turns it into a `NowQuantity` (`evSensor` in lib/planNow.ts) so `FlowBox` shows the age and the hover
  text as for the Measurements sensors; still never judged.

### 2026-10-13: the multi-run .log has each run's summary and artifacts (0.4.30)
- **Why:** the owner downloaded ten `market.reconcile` runs. The .zip was full, but the .log had two lines. Nothing
  was lost: those runs log only when a session starts or ends, and what they decided is in the run's summary and its
  `market_decision` artifact, which the .log left out.
- **Change:** `GET /api/runs/logs` writes, per run, the header (now with `took <n> ms`), the summary as `# …` lines,
  the log lines, then each artifact as `## <kind>` and indented JSON (the bundle's `artifacts`, newest per kind,
  via the shared `artifacts_of`). Formatting runs off the event loop, like the zip.

### 2026-10-13: the Inverter page shows every Sofar button press and who made it (unreleased)
- **Why:** the owner asked whether the Inverter page shows presses of the passive and feed-in buttons made outside
  EMHASS Lens. Before this change it didn't. `sofar_press` recorded them, but only the Market page showed counts, and
  "not ours" was presses minus our commits.
- **Backend:**
  - App migration 0006 adds `source` (`lens` | `automation` | `user` | `unknown`) and `run_id` to `sofar_press`.
    Old rows are backfilled as `lens` where an ok commit lies within 30 s.
  - `SofarWriter.commit` marks each button just before it presses it. `on_button_state` counts a press within 30 s of
    that mark as ours, with the run.
  - Otherwise the HA state's `context` decides: `parent_id` set means an automation, `user_id` set means a user (the UI
    or a script they ran).
  - A press is stored at the button's own timestamp, so a press seen only on reconnect keeps its real time.
  - `presses_not_ours` counts presses with a source other than `lens`, which is exact now.
  - `GET /api/inverter` adds `wear_24h`, `wear_7d` and `presses` (7 days, newest first, at most 200).
- **UI (Inverter page):**
  - The header shows *Inverter writes* (`WearFacts`, moved to `components/controller/`).
  - The day strip takes `ticks`: a dot on the top edge per press, red when made outside EMHASS Lens.
  - The strip's key counts today's presses, and a slot's popup lists its presses.
  - A new **Button presses** panel has an *Only outside EMHASS Lens* filter, and each EMHASS Lens press links to its
    run.
- **Not yet verified on the real Home Assistant:** that the WebSocket `new_state` carries `context` with `parent_id`
  for automation presses and `user_id` for UI presses (that is HA's documented behaviour).

### 2026-10-13: download several runs at once from the Runs page (0.4.28)
- **Why:** the owner wanted to tick runs in the list and download their logs together, instead of opening each run
  for its **Download bundle**.
- **UI (Runs page):**
  - A tick box before every run, and a select-all box in the header that covers the rows shown (indeterminate when
    some are ticked). Shift-click ticks or unticks a range.
  - Ticks are kept by run id, so they survive refetches, filter changes and *Load older runs*. A sticky bar under the
    list says how many are ticked (and how many of them the filters hide) and offers **Download logs (.log)**,
    **Download bundles (.zip)** and **Clear**.
  - The phone card layout gets the tick box as its first column.
- **API:**
  - `GET /api/runs/logs?id=…&id=…` gives one text file: per run, oldest first, a `# Run <id> · <job> · started … ·
    <outcome>` header and its lines in the Logs page's download format.
  - `GET /api/runs/bundles?id=…` gives a zip of `emhass-lens-run-<id>.json`, each the same as that run's
    `/bundle`. It's compressed off the event loop.
  - Both take at most 200 runs (`MAX_DOWNLOAD`, matching `lib/runPick.ts`), so the URL fits behind Ingress. They
    skip runs already removed, and return 404 when none is left.

### 2026-10-13: This slot judges battery and grid by what the inverter does with the PV and load now (0.4.27)
- **Why:** the owner's 11:30 slot (PV export, grid target 0 W, battery −20…0 kW) showed *Battery and grid differ
  from the plan* with nothing wrong.
  - **Measured:** PV 5.00 kW (forecast 4.41), house 558 W (forecast 1.35 kW), grid −4.25 kW (plan −2.92), battery
    0 W (plan 0 W).
  - **Battery:** it was judged against a hidden 1.38 kW charge, because the old rule let the battery take every
    forecast error.
  - **Grid:** it was judged against the plan, although the extra export was exactly the extra PV and the missing load.
- **The rule** is `domain/plan_now.inverter_expected()`:
  - `N = load + deferrable − PV` (measured, else forecast).
  - The battery covers `N − grid target` within its window: −battery_max … −battery_min in EMHASS signs, narrowed by
    EMHASS's battery power maxima. The grid gets the rest.
  - So in PV export the extra PV is exported, while in a force discharge or self-use the battery covers the
    difference.
  - **Where the targets come from:** the Sofar registers now. For the previous slot, or when a register is unknown,
    they come from `decide()` on the plan row. With inverter control off it is the old rule: grid against the plan,
    and the battery takes the difference.
  - **Force charge at the import max:** the battery is now expected to charge at all it takes, not at the plan's
    rate. That's what the inverter does with that grid target.
- **UI:**
  - The Grid and Battery boxes show "expected …" under the plan when that is off the plan. The box grows rather than
    cut it off.
  - A PV or house forecast that missed by 300 W or more is blue.
  - When all does what is expected but that is off the plan, the chip is blue and names why: "More PV and less house
    load than forecast", or "As expected for the inverter's settings".
  - The "Plan:" line keeps "PV" in capitals.

### 2026-10-13: the feed-in limit during a market sell changes only when it has to (0.4.25)
- **Why:** the owner found the apply and feed-in buttons pressed far too often in a Kratt frrup session, with the
  market on Shadow.
  - The evidence: `runs_json_log/` (runs 4368–4471, not committed) and an HA history export for 06:09–06:44 UTC.
  - The session ran 06:20–06:43 UTC. `qw_powerlimit` changed 15 times (1000–5900 W).
  - The automation pressed apply 10 times and feed-in 7 times. Lens agreed in 36 of 37 compares.
- **Findings:**
  - **The meter exports min(grid target, feed-in limit).** When the automation's feed-in cooldown held the limit
    below a rising command, Kratt got 2600 W instead of 4200 W (06:27–06:30), and about 1000 W instead of 5900 W
    (06:30:54–06:34).
  - **The battery discharged nearly all session**, so there was no spare PV for the limit to stop.
  - **The apply presses follow real command changes.** A 60–90 s hold saves at most 2 presses and doubles the
    delivery error, so the passive guards are unchanged.
  - **Run 4381 (mismatch)** came from the 15 s gap between the automation's minute tick and ours.
- **The owner's rule: change the limit only when absolutely necessary.** The 09:20 commands didn't need it to move
  from 15500 W at all, and the data agrees:
  - Spare PV (PV − house) went above the command by at most about 50–100 W, for about 30 s twice.
  - The battery took 620–900 W at 93 % (06:09–06:14).
  - With the limit above the command, export followed the grid target (06:38–06:41).
- **The rule** is `domain/market.sell_feedin()`:
  - Keep a held limit that is at least the command; raise a lower one to `sell_cap_w` at once.
  - Follow the command only when SOC ≥ `market.thresholds.sell_full_soc_pct` (97 %) and PV − house load is more than
    the command plus the deadband (max(300 W, 15 %)). Lowering waits for the cooldown (except at a session start);
    raising never does.
  - The first version used the inverter's 90 % "nearly full". The owner then chose a separate near-full threshold,
    because 90 % would still cap on a sunny day at 92 % with the battery able to take the PV.
  - The deadband margin keeps 17 W of spare PV (06:30:22) from costing two presses.
  - The automation's value is kept as `MarketDecision.parity_feedin_w` and `parity_feedin_write`. `expected_after`
    doesn't judge a sell's feed-in.
- **Replay through the new `decide()`:**
  - 17 → 10 presses (apply 10, feed-in 7 → 0); |delivered − commanded| 0.33 → 0.14 kWh. The limit stays at
    15500 W throughout (the automation left 1000 W).
  - The same without the house load sensor, and even with the battery at 98 %.
- **Also:**
  - `MarketEntities.house_load_sensor` (default `sensor.sofar_active_power_load_sys_watt`), `MarketInputs.load_w`,
    and `sensors.load_w` in the status.
  - In Shadow, minute ticks (`reconcile` and `promoted`) subtract `reconcile_offset_s` from both cooldown ages.
  - Frontend: `parityFeedinText()` (lib/market.ts) under the Feed-in max row, a fourth guard "Feed-in limit only when
    it matters" (with `sell_full_soc_pct`), a "Where EMHASS Lens differs" paragraph, and the house load beside
    battery · PV.
  - The CHANGELOG also carries the watchdog-logging fix c17b939 from another session.
- **Checked:** backend 434 tests, ruff, pyright; frontend typecheck, lint, 205 tests, build; e2e 24/24.
- **Look at it on the real HA:** the next sell session in Shadow should show "The automation would write N W" under a
  kept limit.

### 2026-10-13: the market session watchdog (0.4.24)
- **Why:** the owner wants to switch market control to Live and turn off both HA automations, "Qilowatt: Master Market Controller" and "Qilowatt: Session Watchdog".
  - The HA watchdog (every 5 min) has three branches: clear a stale session (source not kratt/fusebox for 10 min), notify about a 3 h session, notify about EMHASS left off with the inverter forced.
  - The App's `decide()` already ends a lost-source session after 5 min. But nothing independent caught a bug, a stuck run or a refusal (e.g. `qilowatt_automation` off), which was the HA watchdog's whole point.
  - The owner chose "port everything, disable HA". Accepted risk: nothing in the App ends a session while the App itself is down. The Dockerfile HEALTHCHECK plus the App's Watchdog toggle restarts a hung App, and the session is restored and ended on reconnect.
- **Pure check:** `domain/market_watchdog.py` `check()` returns findings `stale` / `long_session` / `emhass_off`, each with an episode key.
  - It shares no logic with `domain/market.py`, only the `STATES` labels.
  - A missing `qw_source` counts from the session start.
  - `stale` is an error in Live and a warning in Shadow.
  - `services/ha_values.changed_at()` reads `last_changed`.
- **Service:** `services/market_watchdog.py` `MarketWatchdog`, job `market.watchdog`.
  - The job runs `Periodic(60, 40)` with `record=False` and `coalesce`. The probe promotes itself to an event run when something is due.
  - A recorded run re-reads over REST and checks again.
  - **Live, stale:** `MarketService.end_and_hand_back(reason="watchdog", owner="watchdog")`, with a phone message at most every 5 min per episode.
  - **Shadow:** `dry_run` only.
  - **long_session / emhass_off:** one message per episode, de-duplicated in memory, so a restart may repeat one.
- **Market service:**
  - `act_lock`: a recorded reconcile (now `_reconcile`) holds it. The watchdog waits up to 120 s for it, then acts anyway.
  - `_close_session` clears `self.session` before its await, so two concurrent ends close a session once.
  - The end tail of `_apply` became `end_and_hand_back()` with `_handback_calls()`.
    - The safe-state fallback always passes the targets, so the state select is fixed even when the registers were safe.
    - A failed select or switch call now makes the run an error.
  - `_hand_off` waits up to 20 s for an `inverter.decide` that is already running, so the hand-off isn't skipped into the fallback.
- **Health:**
  - `market.watchdog.<kind>` for findings checked within 3 min.
  - In Live, `market.watchdog.off` when it's disabled, paused or hasn't checked for 3 min.
- **Settings:** `market.watchdog` (enabled, stale_after_s 600, long_session_s 10800, emhass_off_s 600), with no schema bump. The `mobile_service` description names the market.
- **API and UI:**
  - `MarketStatus.watchdog` (`MarketWatchdogStatus`, `WatchdogFinding`).
  - A "Watchdog" fact on the Market page (`watchdogText` in `lib/market.ts`).
  - The Live confirmation names the Session Watchdog.
- **Checked:**
  - Backend: 428 tests (17 new in `tests/test_market_watchdog.py`), ruff and pyright.
  - Frontend: typecheck, lint, 203 tests and the build.
  - Not yet seen on the real HA.
- **For the owner, when going Live** (DOCS "Moving the automation over"):
  1. Set the Mobile notify service.
  2. Turn on the App's Watchdog toggle.
  3. Turn off both HA automations.

### 2026-10-12: "What EMHASS gets" on the Inputs page (0.4.23)
- **Why:** the owner wanted graphs for everything fed into EMHASS, not only the Nord Pool prices. Mockup approved first: https://claude.ai/artifact/WR78nvnN5kjMJhab3usymr (Plan-style popups and PV day totals added on review).
- **Backend:** `services/sent_inputs.py` (`SentInputsService`), `domain/mpc/sent.py`.
  - `GET /api/inputs/sent?hours_back=` reads the newest `emhass.mpc` run that has an `explain` artifact (its `request` and `inputs` too).
  - `POST /api/inputs/sent/preview` builds one now. `build_now()` is shared with `POST /api/mpc/preview`.
  - The house load is the one input EMHASS forecasts itself. `load_series` takes `P_Load` from the plan that run made (`EmhassService.plan_of_run`), else the newest plan. A `load_power_forecast` in the payload (extra runtime parameters) wins.
  - `deferrables()` pairs the payload's lists with the run's described loads, so an off load still shows what it would ask for.
  - `measured` is the `measurement` table for `hours_back` before the anchor (load, PV, SOC 0–1).
  - `SentInputs` fields have no defaults, so the generated TS types are required.
- **Frontend:** `pages/inputs/SentPanel.tsx`, `lib/sent.ts` (+ tests). Cards and four `TimeChart`s on sync key `sent`:
  - prices, with tariff and export lanes;
  - PV with P10, the EV reserve as a stacked area, and day totals;
  - house load, with a lane per deferrable load;
  - battery, with `soc_init` and `soc_final` marked.
  - **Before the anchor** (Off / 24 h, remembered in localStorage) and **Last run / Preview now**.
- **TimeChart** gained three things:
  - `lanes`: spans drawn between the plot and the time axis. The axis's `gap` grows and its ticks go.
  - `notes`: canvas labels and dots, set to left-aligned because uPlot leaves the axis alignment set.
  - `popup.extra`: rows under a rule (`data-rule`), with hatched swatches for off spans.
  - New token `--q-pv-ink` for the PV labels.
- **Checked** in Chrome against the test suite's fake HA and EMHASS. A scratch script served the app with one live MPC run and 24 h of measurements, and the popups, lanes, labels and both switches worked. Look at it on the real HA after the release.

### 2026-10-12: local times for button entities in Settings; the HACS settings import is removed (0.4.22)
- **Timestamps:**
  - The owner saw `2026-10-12T10:15:02.322394+00:00` beside the Sofar feed-in and apply buttons in Settings → Inverter
    control. A Home Assistant button's state is the UTC time of its last press, and the entity picker printed it raw.
  - `entityReading()` (`lib/entities.ts`) now formats states from the `button`, `input_button`, `scene`, `event` and
    `datetime` domains, and sensors with `device_class: timestamp`. It uses the App's timezone (`status.timezone`, the
    same as the Plan page's "Times in"), and buttons read "pressed …".
- **EV charger audit:**
  - The start and stop buttons in Settings had the same display bug, and the same fix covers them.
  - The Charger page's own times already used the App's timezone.
  - The backend only presses the charger buttons. Sofar's `_pressed_at()` parses the state with its offset, so the
    cool-down math was right.
- **HACS import removed** (the owner's choice, "step, card and backend"): the Getting started step, the Health card
  and jump link, `/api/legacy/preview`, `/api/legacy/import` and `services/legacy_import.py`.
  - Revisions saved by the import keep their label in Settings → History.
  - DOCS and `RETIRING_HACS.md` now say to enter the tariffs under Settings.
- **Answered (no change):**
  - ML tune and ML predict run only on demand.
  - Every MPC run predicts with the model (`load_forecast_method: mlforecaster`).
  - Fit runs automatically: nightly after the first live MPC run from 03:00, and on a model fault at most every 6 h.
- **Checked** with unit tests. Look at Settings → Inverter control and Settings → EV charger on the real HA after the
  release.

### 2026-10-12: one day-strip mark per stretch of the same decision on the Market and EV charger pages (0.4.21)
- **Why:** the owner found that on the Market page's "Today, decision by decision" the hover outline moved around
  inside what looked like one block, unlike the Inverter page.
  - In a Qilowatt session the market reconciles every minute and on every command change (often 10–60 s apart).
  - Each decision was its own mark, at least 60 s long. That is under 1 px, so the marks were drawn at the 2 px
    minimum and overlapped.
- **Now** `holdStretches` (`lib/dayStrip.ts`, replacing `holdUntilNext`) makes one mark of consecutive decisions with
  the same label. A gap over 15 min (+60 s slack) or an unlabelled decision starts a new mark.
  - A mark is amber if any of its decisions differed, and opens the first that differed (else its first).
  - Pointing at a mark shows `StretchPopup`: its time range, what was decided, and how many decisions were the same,
    different or not compared.
  - The market also names `not in control` and `ignored` above the strip, so those merge too.
- **The owner's choice:** stretches rather than quarter-hour slots (asked with mockups). Where Qilowatt changes the
  power every minute, each change is still its own narrow mark.
- **Checked** with unit tests only (no local market runs). Look at it on the real HA after the release.

### 2026-10-12: keep a feed-in limit that already covers the slot (0.4.21)
- **Why:** the owner found the feed-in presses in runs 3267 and 3281 excessive. The export price was fine, and the spare PV went into the battery.
  - Kratt sell sessions had left 3000 W and 3800 W. The plan's spare PV was 2770 W and 1008 W.
  - `feedin_need()` (0.4.8) said the limit mattered (plan SOC 90.3 % ≥ 90 %), and then only exactly 15500 W would do.
- **Audit of the paths that press the feed-in button, and what changed:**

  | Path | Before | Now |
  |---|---|---|
  | Plan decision (slot, publish, resume, market hand-off, catch-up) | needed → exactly 15500 / 0 W | export allowed: a held limit in [floor, export max] is kept; else 15500 W. Cheap (0 W) and curtailment (15500 W) stay exact |
  | Drift check | exact match | the decision's range, so a sufficient value is not drift; a lower one is set back to 15500 W |
  | Dry-run compare | exact | the range |
  | Sofar writer | writes what differs | unchanged |
  | Market live sell | deadband + cooldown, mirrors the automation | unchanged here; since 0.4.25 kept while ≥ the command (see 2026-10-13) |
  | Market end without a fresh plan | leaves feed-in | unchanged |
- **Code:**
  - `domain/inverter.py`:
    - `Decision.feedin_floor_w` / `feedin_ceiling_w` and the property `feedin_range`.
    - The floor is the larger of the plan's export and its spare PV, rounded up to 100 W, with no margin; the ceiling is `export_max_w`.
    - `decide()` keeps `held.feedin_max_w` within the range, with "kept: …" in `feedin_why`. A drift correction (`held=None`) writes the export max.
    - `compare_targets(..., feedin_range)`.
  - `services/inverter.py`: `verify_job` passes the range.
  - `frontend/src/lib/inverter.ts`: the two optional fields.
- **Tests:**
  - `test_inverter.py`: runs 3267/3281 kept, below the floor, above the export max, drift, cheap, curtailment, compare.
  - `test_inverter_service.py`: a sell leftover is kept live, a sufficient change isn't drift, a lower one is set back.
  - Results: 404 backend tests, ruff, pyright; frontend typecheck, lint and 190 tests. e2e not run.
- **For the owner:** "Battery counts as nearly full at" (90 %) is conservative; the battery was 92 % and still charging at 13:46.

### 2026-10-12: Runs filters: several jobs and outcomes, include or exclude (0.4.20)
- **Why:** the owner wanted the jobs A–Z, several jobs at once, and a way to leave jobs and outcomes out.
- **API:** `GET /api/runs` takes `job`, `outcome`, `not_job` and `not_outcome`, each repeatable.
  - `RunRecorder.list` builds `IN (…)` / `NOT IN (…)` clauses. A single `job` string still works for every other caller.
  - Test: `test_runs_filter_by_several_jobs_and_outcomes`.
- **URL:** the page uses the same keys as the API (`?job=a&job=b` or `?not_job=a`), so old `?job=emhass.mpc` links still work.
  - `lib/multiFilter.ts` (`readMulti`, `writeMulti`, `multiQuery`, `multiSummary`) has tests.
  - `query()` in `api/client.ts` repeats a key for an array.
- **UI:** `components/MultiFilter.tsx` is a select-like button and a panel.
  - The panel has an Include/Exclude `.segmented` switch, a checkbox per option (outcomes with their lamp), Clear, and a hint line. A ticked option is struck through in Exclude.
  - With nothing ticked the mode is local state, since the URL has no key for it.
  - The panel moves sideways to stay inside 16 px gutters on a phone.
  - The outside-click/Escape handling moved from `StatusMenu` to `components/useDismiss.ts`, which both use.
  - Outcomes keep their order (OK … Error). A picked job that is no longer registered stays in the list so it can be unticked.
- **Checked** in Chrome against a local backend with seeded runs:
  - A–Z order; include two jobs; switch to Exclude; exclude outcomes picked before ticking;
  - Escape and an outside click close the panel;
  - `?job=emhass.mpc`;
  - 390 px in an iframe (the panel at 57–357 px, no sideways scroll).

  Backend: 393 tests, ruff, pyright. Frontend: typecheck, lint, 184 tests, build. e2e was not run.

### 2026-10-12: in market shadow mode the hold follows the market's session select (0.4.19)
- **Why:** the owner sent runs 3267 and 3281 (inverter live, market shadow, two Kratt sell sessions at 13:07–13:14).
  - At a session end the automation writes the safe passive state but not the feed-in limit (`domain/market.py`). So 3000 W and 3800 W stayed behind.
  - The hold was off, so the drift check set 3000 W back 1m45s later (13:11:30), and the slot decision at 13:15:02 fixed 3800 W.
  - A drift restore after every session also counts toward the 3-per-hour fight limit.
  - The owner wanted the hold to come from the market setup, not from a separate setting.
- **Change** (`services/external.py`):
  - `source()` returns the (entity, busy values) the hold follows.
  - With market control on Shadow, that's always `market.entities.session_select` with buy/sell, whatever `external_control.enabled` says. Otherwise the hold's own settings apply, as before.
  - The source isn't `sensor.qw_source` being kratt/fusebox. A command below the start gate (kratt frrup 600 W at 13:10:55) has no session, and the source is still kratt after a below-gate end.
- **Wiring:**
  - The state listener matches `external.entities()`.
  - `on_settings` also runs on `market.mode` and `market.entities`. It picks up a select that is already busy.
  - Switching market to Live clears a hold (the App hands back itself) without a resume.
- **Health:** `external.entity_missing` checks the followed entity, and links to the market settings when that's the select.
- **Settings:** the descriptions of the session select and the hold's switch say so; `openapi.json` and `schema.d.ts` are regenerated.
- **Tests:** three new tests in `test_external_control.py`: a shadow session holds and hands back with the switch off; leaving shadow; the missing select. 393 backend tests, ruff, pyright. Frontend checks and e2e were not run (descriptions only).

### 2026-10-12: the price breakdown as columns (0.4.18)
- **Why:** the owner found the stacked areas hard to read: the grey spot ran together into one shape.
  - Canvas with the options: https://claude.ai/artifact/4573i4QumxjxRGf1XRitmn. The owner picked B: quarter-hour columns, part gaps, a clearer palette.
- **`TimeChart`** gained `ChartSeries.column`:
  - `'stack'` draws one column per slot from the `below` series (or zero) to the value. It uses a custom uPlot path builder that returns a `Map` of fill style to `Path2D` and draws no stroke or uPlot band.
  - `'cap'` is a 2 px bar at the value (none at `width` 0).
  - Columns in `bands` (the forecast) are drawn at 55 %.
- **Geometry** lives in `lib/chartColumns.ts`, which has tests:
  - `columnGap` is 2 / 1 / 0.5 / 0 px by slot width.
  - `columnSegment` puts a 1 px gap at the low end of a part that sits on another, and at the zero end of a negative spot.
  - `slotIndex` finds the slot under a value; `inRanges` tells whether a slot is in a forecast.
- **Cursor:**
  - On a chart of columns, `follow()` adds `CursorAt.column` (the column's box). `ChartPopup` rings it (`.chart-col-ring`) and anchors the popup at its top.
  - Column series get no cursor dots (`is-column`) and the cursor line is hidden (`[data-columns]`).
  - The new prop `snapToSlot` (on both Inputs charts) moves uPlot's cursor to the start of the slot under the pointer with `cursor.move`. uPlot's nearest-index rule had shown the next slot over the right half of a slot. The Plan charts still use the nearest index.
- **Colours:** a new `--stack-spot` (#6e6d68, dark #7d7c77) for the columns only; `--q-spot` stays for the spot lines. Fees, network and VAT are now #c4b6f3, #8a6ee0 and #4a2fb0 (dark #4a3b8f, #7b62d3, #b8a8f8), so neighbours still differ in lightness.
- **Checked** in Chrome against a local backend with today's Nord Pool prices:
  - All days and Today, hover from either chart (same slot, ring, popup);
  - a negative spot and a forecast tail injected into `/api/prices`;
  - Spot switched off;
  - dark tokens;
  - 390 px in an iframe (docked popup, 1 px gaps).

  Frontend typecheck, lint, 179 tests and the build pass. e2e was not run.

### 2026-10-12: inverter rules: one "chosen now", a clearer list, battery caps at the plan (0.4.17)
- **Why:** the owner saw "chosen now" on rules 7 and 9 at once and asked for a review of the rules.
  - Both rules end in the mode `self_use`, and the list matched on the mode. Only one rule ever matches. Rule 7 (exporting with an idle battery in a cheap slot) can hardly happen, because EMHASS gets `maximum_power_to_grid = 0` for those slots; it fires only when the export price is unknown.
  - The review found two rules where grid 0 W doesn't do what the plan says, because the battery takes all the slack. `use_bat_import` drains the battery that the plan saved for a dearer slot. `charge_export` puts all the surplus in the battery and exports nothing.
- **Tag:** `Decision.branch`, one key per rule (`domain/inverter.py` `BRANCHES`; rule 7 is `self_use_keep_pv`). `rule` and `label` are unchanged, so history, summaries and the automation comparison are too. `RulesExplainer` tags `r.key === branch`.
- **List:** `InverterRuleText` (key, group, title, state); the charger keeps `RuleText`.
  - Three groups (importing, exporting, neutral) numbered 1–9 across them (`.rule-groups` holds the counter).
  - Each rule has its own title: three of them set the passive state "Self-use battery or PV".
  - *More about decisions* lists the deviations (`deviations()`).
- **Caps** (`InverterLimits.cap_discharge_at_plan`, `cap_charge_at_plan`, both on; `battery_cap_slack_w` 500):
  - `use_bat_import` gets battery min = −cap(P_batt).
  - `charge_export` gets battery max = cap(−P_batt), but not in a cheap slot, where the feed-in limit is 0 W.
- **`battery_cap()`:**
  - Writes the plan + slack/2, rounded up to 100 W, and keeps the register's cap while it is in [need, need + slack].
  - A fixed grid of slack-sized steps was tried first: the hold then adds almost nothing, and a plan at a step's edge (990/1010 W) writes every slot.
  - A scratch simulation over random walks, noise and rising plans: 2–3× fewer apply presses than following the plan to 100 W; ~270 W above the plan on average.
- **Service:** `decide_job` passes the registers as `held`, except drift corrections (`held=None`), so a value someone else wrote within the slack is set back, not adopted.
- **Verified:** backend 389 tests (new ones in `test_inverter.py` and `test_inverter_service.py`; the drift test fails when `held` is always passed), frontend 171 tests, ruff, pyright, lint, build. Also checked in Chrome against the local backend, behind a proxy that injected a decision: three groups numbered 1–9, a single tag for `self_use` and for `use_bat_import`, and no horizontal scroll at 390 px (in an iframe). e2e not run.
- **To watch:** the day strip and the wear on the Market page after a few evenings with `use_bat_import`. The caps cost presses that grid 0 W didn't; raise the slack if they add up.

### 2026-10-12: Inputs, prices and their breakdown on one time axis (0.4.16)
- **Why:** the owner wanted:
  - the Inputs page in the Plan page's price colours;
  - the price chart and the breakdown below each other;
  - one cursor with Plan's popups across both.

  Canvas: https://claude.ai/artifact/6iQyQPsfVZQVkkbXotb5Po (approved as drawn).
- **Layout** (`pages/InputsPage.tsx`):
  - One Prices section: a day switch (All days + each day loaded), then the price chart, then the breakdown, then the table of the chosen day.
  - Nord Pool and Price forecast come after.
  - Both charts share `syncKey="prices"` and one zoom (`snapWindow`); a day's button zooms to `dayBounds`.
- **Breakdown** (`pages/inputs/PriceStack.tsx`) is now a `TimeChart` over every slot, replacing the hand-drawn SVG of one day:
  - Stacked step areas from `lib/prices.ts` `stackLayers`, which replaces `stackSegments`/`stackExtent` and keeps their rule: spot from zero, the rest from `max(spot, 0)`, a hidden part as a zero-thickness layer.
  - `TimeChart` gained the series fields:
    - `below`: uPlot `bands` fill to that series;
    - `readout`: the popup's value when drawn values are sums;
    - `helper`: the stack base, with no row and no dot;
    - `muted`: a part switched off, faded in the popup;
    - `total`: the import row under a rule.
  - It also gained `legend={false}`, and `fit.zero` keeps zero in view.
  - Popup tags: the rate (`periodLabel` + " rate") on the breakdown, the origin (`originLabel`) on prices. 3 decimals in €/kWh, 1 in c/kWh.
- **Colours:** `--stack-fees` / `--stack-network` / `--stack-vat` are now violets from light to deep (#ddd4f7, #9f86e3, #5e43c2; dark #3b2f66, #6c55b8, #9f8af0).
- **Checked** with the mock API:
  - hover syncs both charts;
  - forecast and night-rate tags;
  - the negative spot dips below zero;
  - Today zooms both;
  - Spot switched off restacks from zero and fades its row.

### 2026-10-12: a value popup on every Plan chart, taller charts, new colours (0.4.15)
- **Why:** the owner wanted the values next to the cursor instead of in the legend, slightly taller charts, and clearer colours (the state of charge in the battery's blue, the red price with the dotted green one). Canvas: https://claude.ai/artifact/BSj6NXeucdtCoZPA3Z5v4z. The owner picked B (a popup on every chart at once), colour option 2, and battery + for charging.
- **Popup** (`components/charts/ChartPopup.tsx`, store in `cursorStore.ts`, logic in `lib/chartPopup.ts`):
  - `TimeChart` takes `popup={{ tag }}`. Its legend then stops being live and becomes a key.
  - uPlot's `setCursor` hook hands `{idx, left, pointerY, points}` to the store once per frame, and the popup is portalled into `u.over`. Synced charts all show theirs. The chart under the pointer (mouseenter/leave) marks the nearest line with a ring and a shaded row.
  - It flips left past 58 % of the width and is clamped into the plot after measuring its height (`useLayoutEffect`, no state).
  - Below 520 px of plot only the hovered chart shows one, docked across the top.
  - `ChartSeries.then` folds a "planned at the time" series into the row before it, as the "planned then" column on a blue band (`--then-band`, `--then-ink`). The key hides those series (uPlot `class: 'is-then'`).
- **Plan charts:**
  - Heights are 300 / 210 / 210.
  - The battery is drawn with + charge (`negated`), and battery and grid use `formatSignedPower` with direction words.
  - Prices show 3 decimals and are tagged by origin (`originLabel`: Nord Pool / Forecast (eupowerprices.com)).
- **Colours** (`tokens.css`):
  - `--q-soc` teal (#0f8f86 / dark #2bb3a8), also used for This slot's SOC bar.
  - `--q-import` #33197d / dark #d4c8ff and `--q-export` #a874de / dark #8f55c9, both solid, also on the Inputs price chart.
  - Not run through the dataviz validator; the owner chose them on the canvas.
- **Checked** with the mock API: hover in the past and the plan, a flip near the right edge, the forecast tag, docking at 390 px. Dark mode was not looked at.

### 2026-10-12: tabs on top, This slot as a flow with measured values first (0.4.14)
- **Why:** the owner found the sidebar took too much width inside the HA panel, and the Plan page's seven equal tiles hard to read. Canvas: https://claude.ai/artifact/Q5eFpzfREXZHQQkz3nwpDC. The owner picked nav A (two rows) and This slot A (flow), with two changes: the measured values are the big numbers and the plan the line under them, and the page shows when the values last changed.
- **Shell** (`components/Layout.tsx`): `Tabs` replaces `Sidebar` and `Crumbs`. The top bar's first row has the brand, the update link, ⌘K, the status chip, problems and Run MPC; the second row has the pages from `lib/nav.ts` as `.page-tab`s in `.page-tab-group`s (`.tabs` is the Run page's tab list). The current tab is scrolled into view on narrow screens. No drawer any more; `navLocation` and the `menu` icon are gone. `main` is up to 1440 px wide.
- **This slot** (`pages/plan/ThisSlot.tsx`, logic in `lib/slotFlow.ts`):
  - `planValues` / `measuredValues` (the charger's `power_w` as the EV), `flowHeadline` (from the measured values, falling back to the plan per quantity; the plan's own line is shown when it reads differently), `agreement` (battery, grid, SOC), `flowNodes`, `flowSegments` and `segmentBox` (line thickness 3–16 px for 0–20 kW, arrows in the middle, a dashed hairline below 100 W), `priceInDay`.
  - Two layouts, `WIDE_FLOW` (720 px) and `NARROW_FLOW` (328 px), picked by the flow's own width (ResizeObserver) and scaled down below 328 px.
  - Ages: `age_s` plus the query's `dataUpdatedAt`, ticking every 5 s. `usePlanNow` refreshes every 10 s and on plan, inverter and charger events.
- **Backend:** `PlanNow.soc_min` / `soc_max` from EMHASS's config (`battery_minimum_state_of_charge` / `battery_maximum_state_of_charge`), `ChargerNow.power_w` (`deferrable_now`). Tests in `test_plan_now.py` and `test_charger_service.py`.
- **Checked** with a mock API at 1280, 900, 390 and 360 px, light and dark, in three situations (night Force charge, midday charge + export with the EV, a slot that differs). Not yet against the real HA.

### 2026-10-12: one battery min for every mode that may discharge (0.4.13)
- **Why:** the owner's call, to simplify the settings and the logic.
  - `force_charge_battery_min_w` (−3000) and `export_only_battery_min_w` (−16000) are removed. Force charge and self_use_pv_export use `battery_min_w` (−20000) like the other modes, and use_only_grid keeps 0.
- **Safe because** Sofar passive mode clamps the battery to [min, max] while it chases the grid target:
  - Force charge's target is the import max (0.4.12), so the window only matters above 18.8 kW + PV of house load, where −20000 holds the grid at the fuse limit. Market buy sessions already used `battery_min_w` in Force charge (`domain/market.py`).
  - self_use_pv_export has grid 0 and battery max 0, so only a house load above PV + 16 kW differs.
  - With `force_charge_at_import_max` off, the battery may now cover house load above the plan's P_grid + margin; its description says so.
- **No fewer presses:** every mode change that moved battery min also changes grid power or battery max. There's one write at the first Force charge after the update.
- **Settings schema 6:** `_v5_to_v6` drops both keys. Without it, `extra="forbid"` would reject the stored revision. Tested in `test_schema_5_settings_drop_the_per_mode_battery_mins`.

### 2026-10-12: Force charge holds the import max (0.4.12)
- **Why:** runs 2791/2803 (the owner's exports): two Force charge slots in a row.
  - 02:00: P_grid 12685 W is above the 9000 W cap, so the grid target was 18800 W.
  - 02:15: P_grid 3795 W gave round100 + 1000 W margin = 4800 W. That cost 3 number writes and another apply press, an EEPROM write, only to lower the grid power.
- **Change:** `InverterLimits.force_charge_at_import_max` (default on). `domain/inverter.py` `decide()` then sets `grid_import_max_w` in every Force charge slot, and the BMS limits the charge.
  - Consecutive Force charge slots have identical targets, so `SofarWriter.plan_calls` writes nothing ("Already set").
  - Off restores the automation's rule (cap + margin). `tests/test_inverter.py` keeps its automation-parity table with it off.
- **Trade-off (owner's choice):** a Force charge slot where the plan wants a small top-up charges at full power. The next MPC starts from the real state of charge.
- **Dry run:** with it on, the comparison with the automation differs on `grid_power_w` in Force charge slots at or below the cap.
- **Tests:** `test_back_to_back_force_charge_slots_write_nothing` replays the two slots: no service calls in the second. It fails on the old rule with "grid 4800 W".

### 2026-10-12: the Inverter page's day strip in colour, with a popup per slot (0.4.11)
- **Why:** the owner found "Today, slot by slot" all grey (in live no compare runs exist, so every slot was "not compared") and couldn't see where the mode changed. Mockup approved first: https://claude.ai/artifact/CVGh35JPPNzAoNsmNmcLSd (self-use changed from slate to lavender on the owner's request).
- **Colours:** `--mode-*` tokens in `tokens.css`, one per passive state (import to export: force charge blue, grid only slate, self-use lavender, restrict export lavender with dots, charge + export blue/aqua stripes, PV export aqua, force discharge orange; `--mode-blocked` hatches the slots not in control). Blue, orange, aqua and lavender pass the dataviz validator's all-pairs CVD and normal-vision checks in both themes.
- **Data:** no backend change. `lib/inverter.ts` reads the five settings from the decide summaries (`parseDecisionTargets`, `decisionAction`) and the automation's values from the compare summaries (`compareDiffs`); `inverterStrip` builds the strip inputs (fill, label, quiet self-use labels, the line under the strip, a `SlotDetail` per slot with the fields changed since the last slot in control and the feed-in limit's last change).
- **`DayStrip`** is HTML now (absolutely placed buttons, no SVG) so textures render, with optional `legend`, `footer` and `detail` (popup on hover, keyboard focus or tap; one tab stop, arrow keys move). Market and the EV charger pass none of them and keep their green/amber/grey marks. `stripLabels` takes the strip's width and lets quiet labels give way; `stripRuns` rounds and separates runs of equal marks.
- **Popup:** `components/controller/InverterSlotPopup.tsx`.

### 2026-10-11 (night): MPC timeouts: derating left out, the retry fires on HTTP 400, publish posts the last good plan (0.4.10)
- **Why:** runs 2405/2406 (the owner's export).
  - MPC stopped at its 63 s limit, then EMHASS's relaxed retry stopped there too (126 s, no plan). Then publish-data failed with "Optimization result is incomplete (status: User_Limit)". This happened several times in a row in the evening.
- **Cause: `battery_charge_power_derating` `[[0.89,0.5],[0.96,0.14]]` in the owner's EMHASS.**
  - EMHASS 0.18.5 (`optimization.py` ~3211-3245) adds a boolean `soc_above[i, t]` per step and slot, tied to the cumulative SOC with big-M in both directions.
  - EMHASS's "relaxed LP" retry only drops the deferrable-load binaries. D, E, soc_*_recovered and soc_above stay, so it is still a MILP.
  - Replaying run 2405's request against EMHASS 0.18.5 in Docker on the Mac:

    | Variant | Solve time |
    |---|---|
    | With derating, 1 % gap | 20.5 s |
    | With derating, 5 % gap | 0.1 s |
    | One step only | 2.8 s |
    | Horizon cut to 112 slots | 2.4 s |
    | Without derating | 0.3 s |

  - The test fixture config has no derating, which is why it never showed in tests.
  - The owner's soc_final is 1.0 (`input_number.emhass_target_soc` = 100), so every plan crosses both thresholds.
- **Derating off** (owner's choice): `domain/mpc/payload.py` sends `battery_charge_power_derating: []` whenever EMHASS's config has a table.
  - It is a runtime parameter (plant_conf in EMHASS's associations.csv).
  - The run gets an info issue `charge_derating_off`.
  - Extra runtime parameters can put the table back. Compat builds don't send it.
- **Retry bug:** `services/mpc.py` only retried when `not response.error`, but EMHASS 0.18.5 answers a timed-out solve with HTTP 400 (any ERROR line in the action's log means 400).
  - The gate is now just `budget.timed_out(last_run, limit, body)`, which also accepts "also failed with status: user_limit" in the body.
  - A timed-out HTTP 400 is explained with `explain_error` instead of the raw line.
  - `tests/world.py` answers a timed-out solve with 400 like 0.18.5 (`emhass_timeout_http`, 200 for older versions). The old fake answered 200, which is why the tests stayed green.
- **Republish:**
  - Live sends add `entity_save: true` (comparison steps drop it).
  - EMHASS writes `data/entities/*.json` only for a publishable result: `publish_data` returns before saving on a status-only frame. Checked with a replay, where the md5 was unchanged after a failed run.
  - `MpcService` keeps kv `mpc.live_result` ({ok, run_id, at, why}, written in a `finally` around `_send`) and `mpc.saved_plan` ({at, run_id, generated_at}, on ok with entity_save).
  - `PublishService.run`: when the last live run wasn't ok, or a cost-function leftover exists (that noop is gone), it calls `publish-data {"publish_prefix": "all"}` while `saved_plan` is within `health.plan_max_age_slots`.
    - Otherwise `RunRefused` (no saved plan yet / older than 30 min), without calling EMHASS.
    - The run gets a `republish` artifact, `payload` in `response`, and `republished_because` in the event. The summary reads "Republished HH:MM from the plan of HH:MM (#id): … . <why>".
- **Error line:** with entity_save, a failed MPC's log ends with publish's "nothing to publish" ERROR. `clients/emhass.py` `main_error()` skips that follow-on line.
- **Tests:**
  - `test_republish.py`. Its clock steps sit off the quarter-hour schedule and away from the nearest-rounding mid-slot guard, which waits in real time.
  - `test_solver_retry.py`, parametrised over 400/200, plus `main_error`.
  - `test_mpc.py::test_charge_power_derating_is_planned_without`.
  - `test_costfun_service.py`: the leftover now republishes.
- **e2e:** two new checks, 24/24.
  - A solve forced to stop at `lp_solver_timeout: 0.001` is followed by a republish (EMHASS 200, `sensor.p_batt_forecast` equals the event), then a normal publish.
  - Found on the way: EMHASS stamps plans to the second and `plan_snapshot.generated_at` is UNIQUE (INSERT OR IGNORE). Two optimisations finishing within one second keep the first plan. entity_save's ~30 ms pushed the e2e's back-to-back runs into the same second, so the no-export step now waits 1.1 s. That is harmless for quarter-hourly runs, but worth knowing.
- **Upstream EMHASS ideas** (not filed):
  - The relaxed retry can't rescue a timeout because the battery and grid binaries stay.
  - The derating indicator only needs the "SOC ≥ threshold ⇒ above" direction.
  - A time-limited incumbent is discarded.
  - "Optimal (Relaxed)" maps to `error` in last-run.

### 2026-10-11 (evening): prices in €/kWh everywhere, a narrower accuracy card, total cost function, previous slot (0.4.9)
- **Why:** redesign D (0.4.0, 0.4.1) brought c/kWh back to the Plan page (`formatCents`, `centsTick`), although 0.3.x had switched it to €/kWh. On the Inputs page, switching the unit to €/kWh left the chart's legend in c/kWh and every axis label at "0 c".
- **The Inputs bug:** `TimeChart` captured `yFormat` and the series' `format` only when it built the uPlot instance, and `specKey` doesn't include them, so a unit switch only called `setData`. Both formatters are now read from the `extras` ref at draw time. That also protects the cost-function chart's kW/% switch.
- **€/kWh:** this slot's tiles, the price chart, the plan table (`planColumnUnit` returns `€/kWh` with 4 decimals), the publish event and the Inverter page all use €/kWh. `formatCents` and `centsTick` are gone. The Inputs page keeps its toggle, but it now starts at €/kWh.
- **Accuracy card:** three columns, Quantity | Last 24 h | Last 7 d. Each cell has the error and the bias under it ("error · bias" in the header). The 7 d slot count is under the quantity, and the price forecast's unit is in its label. With worst-case values it fits the narrowest two-column panel (307 px at a 950 px window) and phones without scrolling.
- **Total cost function** in the Plan page's facts row: Σ of the plan's `cost_fun_*` column (`lib/plan.ts` `costFunTotal`). That is the number EMHASS publishes as `sensor.total_cost_fun_value`, so it needs no Home Assistant read.
- **Previous slot:** `GET /api/plan/now` adds `prev_start`, `prev_row` (the newest of the last 6 plans that has the slot) and `prev_quantities`. The latter is the plan row judged by `compare()` against the slot's stored quarter-hour means. The SoC is judged half-way through the slot, because the stored SoC is a mean. NowSlot switches between Previous slot, This slot and Next slot; the previous slot's tiles say "measured …" and their hover says "quarter-hour mean of …".

### 2026-10-11: feed-in limit written only when something can reach the grid; battery window labels (0.4.7, 0.4.8)
- **Why:** run 1817 (08:15, PV 307 W, house about 960 W, battery 73 %) wrote the feed-in limit 15500 → 0 W and pressed its button although nothing could be exported. The owner pointed out that every press wears the Sofar's EEPROM. With prices around the 0.04 threshold, run 1814's next 24 h would have flipped the limit 10 times.
- **0.4.8:** `domain/inverter.py` `feedin_need()`: the limit matters when the plan exports (P_grid < −100 W), curtails PV, or has PV to spare (−(P_batt + P_grid) > 100 W) while the plan's SOC for the slot (`SOC_opt`, now in `PlanValues.soc`) is at or above `inverter.limits.battery_full_soc_pct` (90; an unknown SOC counts as full). `Decision.feedin_needed` / `feedin_target`: apply, readback, dry-run compare and the drift check use `feedin_target`, so a limit left as it is is never written, judged or set back. The value itself is still price-based (`feedin_max_w`). This is a deliberate difference from the template automation, which writes it every slot.
- **0.4.7:** Sofar's passive battery window counts charging as positive (solax-modbus docs), the opposite of EMHASS's P_batt. Settings titles (`battery_max_w` = charge max, `battery_min_w` = discharge max) and the rule texts said it the other way round. Only labels changed.
- Tests: `test_inverter.py` (feed-in need cases, the threshold setting, not judged), `test_inverter_service.py` (live leaves the limit alone in run 1817's slot, writes it when PV is curtailed, no drift correction for a limit not written).

### 2026-10-11: run pipeline and the price breakdown in reds (0.4.6)
- The run pipeline was only in the canvas mockups. It is now built for runs that call EMHASS (`emhass.mpc`, `emhass.costfun_compare`):
  - `lib/pipeline.ts` (`buildPipeline`, tests use run 985's numbers) and `components/RunPipeline.tsx`, on the Summary tab.
  - `response` and `costfun:<method>` artifacts now carry `sent_at` (`services/mpc.py` `_attempt`, `services/costfun.py`). Older runs are placed from `generated_at` / `emhass_last_run.timestamp` minus the call's duration.
  - EMHASS's `stage_times` are laid end to end, ending with the live call. They add up to slightly more than `duration_total_seconds`, so their sum is used.
- Artifact queries are shared through `api/artifacts.ts`.
- Price breakdown in design B's colours: spot `--q-spot`, fees, network and VAT `#f2aaa9`, `#e34948`, `#9b2c2b` (`--stack-*`).

### 2026-10-10 (night): Runs timeline with dense bars and a window switch (0.4.5)
- The owner asked for design B's bars (equal buckets, side by side) and design A's 1 h / 6 h / 24 h switch on the Runs timeline.
- Backend: `GET /api/runs/timeline?since&until&bucket_s` (`recorder.histogram`, one GROUP BY over the indexed started_at) gives counts per job, outcome and bucket with the newest run id, so a busy day isn't cut at the list's 1000-run cap. Test in `tests/test_runs_range.py`.
- Fix: the EV charger decided twice around a publish (the owner saw pairs of "Nothing to do" at :00:02 and :30:02). The publish chain and `on_deferrable_state` both asked, and the existing guard only worked when the publish's decision had finished first. Both now go through `ChargerService.ask_emhass_decision`, which asks once per (slot, EV power W). Test `test_one_decision_per_slot_and_ev_power_however_the_news_arrives`.
- Frontend: `lib/runLanes.ts` (`TIMELINE_WINDOWS`, `timelineBounds`, `timelineCells`), `components/RunTimeline.tsx` rewritten; the window is `?window=1h|24h` (6 h by default).

### 2026-10-10 (night): redesign "D", step 3: controller pages and price breakdown (0.4.4)
- Inverter, EV charger and Market share the D controller layout:
  - `components/controller/ControllerHead.tsx`: title, experimental tag, an on-page mode switch that writes `inverter|charger|market.mode` through `useSetControllerMode` with a confirmation (Live names the HA automation), the explanation line and the facts row.
  - `AgreementFact` (with a bar), `CompareChip`, and `DayStrip` (built by `lib/dayStrip.ts`: `stripItems`, `stripLabels`, `stripRuns`, `holdStretches`) for "Today, slot by slot" (decision by decision for the charger and the market).
  - The explainers in `components/*Views.tsx` are now sections with a visible numbered list (the current rule or branch tagged) and the prose under "More about decisions".
- Price breakdown: spot in `--q-spot`, fees/network/VAT in greys (`--stack-*` tokens), VAT outlined; the legend toggles are pills.
- Dark mode of the redesign is still unchecked (the owner asked to skip it for now).

### 2026-10-10 (night): no export at or below a price, in the plan (0.4.3)
- `EmhassMpc.no_export_at_or_below` (schema 5; `_v4_to_v5` moves `inverter.limits.low_export_price`, default 0.03 when absent). Used by `domain/mpc/payload.py` (per-slot `maximum_power_to_grid`, via `domain/mpc/export_limit.py`) and `domain/inverter.py decide(…, no_export_at_or_below)`; None never blocks.
- Sent only to EMHASS ≥ 0.16 (`_parse_power_limit`, vector limits) with `compute_curtailment` true, otherwise an `export_limit_unsupported` warning and a `no_export` check under Health → EMHASS. Not in compat builds (parity). `validate` checks the list length (EMHASS falls back to the first value on a mismatch).
- EMHASS 0.18.5 keeps `maximum_power_to_grid` in its cache key (not a runtime key), so a changed list rebuilds the problem; it caches one problem only.
- e2e: a new check sets the threshold to 1 €/kWh and confirms the live plan exports nothing (it exported up to 15.5 kW without it).

### 2026-10-10 (night): redesign "D", step 2: page layouts (0.4.1)
- Plan: `lib/planSummary.ts` (the one-line summary), facts row, Chart/Table toggle, `TimeChart` got `ticks`/`onTick`/`compact` for the MPC run strip (`PlanCharts` → `MpcRunStrip`), prices in c/kWh (`formatCents`, `centsTick`), plan table column names (`planColumnLabel`/`formatPlanCell` in `lib/plan.ts`).
- Runs: `components/RunTimeline.tsx` (lanes from `lib/runLanes.ts`), `pages/RunPreview.tsx` beside the list at ≥ 1180 px (`?run=` in the address).
- Run detail: tabs Summary / Artifacts / Logs (`?tab=`); artifact names moved to `lib/artifacts.ts`.
- Health: sticky section links. Settings: "was …" next to changed fields. Logs: `lib/logVolume.ts` strip.
- Checked against the e2e stack (real HA 2026.10, EMHASS 0.18.5) with a local App in live mode; the Inputs page, the controller pages (Inverter, EV charger, Market) and the phone layouts only got the shared look so far.

### 2026-10-10 (night): redesign "D", step 1: look and shell (0.4.0)
- The owner picked design **D** from the canvas https://claude.ai/artifact/1rEYmoWQuv6B9U7cMq1eKo: row C's "Workbench" layout (text sidebar, ⌘K, frameless sections, hairlines) in row B's Home Assistant colours (cool greys, HA blue for actions and selection), Geist kept.
- Step 1 (this release) changes every page at once through the shell and the shared CSS:
  - `styles/tokens.css`: the D palette, light and a matching dark one; `--on-*` text colours for status text on tints; `--q-*` fixed quantity colours for charts.
  - Geist and Geist Mono come from `@fontsource-variable/*` (bundled, no network).
  - `components/Layout.tsx`: sidebar (groups from `lib/nav.ts`), top bar (breadcrumb, ⌘K button, `StatusMenu` chip with the mode switch, problems chip, Run MPC now), one banner slot. `CommandPalette.tsx`, "g + letter" shortcuts.
  - `.panel` is frameless now (heading + hairline); buttons are outlined blue, `.primary` filled blue; the selected state is the light-blue pill everywhere.
- **Next (step 2, page layouts):** Plan (summary line, key-figure row, MPC run ticks on the time axis), Runs (timeline strip + list with a run preview), Run detail (tabs: Summary · Payload · EMHASS response · Artifacts · Logs), Health (in-page section links), Settings (inline old → new on changed fields), Logs (volume strip), prices in c/kWh everywhere, phone layouts for Plan and Runs. The canvas rows D01–D12 are the reference.

### 2026-10-10 (evening): auto-refresh gaps closed (0.3.20)
- Logs page: without the live stream (`useEvents().state` is `polling` or `reconnecting`) it polls `/api/logs?limit=500` every 5 s into the same buffer as live lines.
- Run details: `useRun` and the run's log query refetch every 3 s while the outcome is `running`.
- `useRuns` with an `until` more than 10 minutes in the past uses the key `['runs-closed', …]` with `staleTime: Infinity`, so run events don't reload past days (`isClosedRange` in `lib/days.ts`); pinning a run invalidates it. Market sessions of a past day stop polling once none is open.

### 2026-10-10 (evening): filter, sort and dates on every recent list; a time range on Runs (0.3.19)
- `GET /api/runs` takes `since`/`until` (UTC ISO, `started_at` in `[since, until)`), `order=asc|desc` and an `after` id cursor; `/api/market/sessions` takes `since`/`until`. Tests in `backend/tests/test_runs_range.py`.
- Frontend: `lib/days.ts` (a day's bounds in the HA time zone, DST-safe), `lib/sort.ts`, `lib/listParams.ts` (list state in the URL with a per-list prefix), `components/ListControls.tsx` and `components/SortableTh.tsx`. `formatDateTime` and `formatSlotDate` in `lib/format.ts` always show the date.
- Used on the Charger, Inverter and Market lists, Market sessions, Runs (From/To, Today/Yesterday, server-side order for Run and Started), cost-function comparisons and the problem history.

### 2026-10-10 (evening): steady chart legends (0.3.18)
- `.time-chart .u-legend .u-value` is inline-block with `min-width: var(--legend-value-width, 10ch)`; `TimeChart` takes `legendValueWidth` (the price charts use 13ch). The owner's Power legend wrapped to a third row for "−5.00 kW … 1.04 kW" and back for "−4.85 kW … 866 W", moving the SoC chart.

### 2026-10-10 (evening): the update check also asks GitHub (0.3.17)
- `UpdateService._github`: version from `raw.githubusercontent.com/anton4/emhass-lens/main/emhass_lens/config.yaml`; when newer than installed, an anonymous ghcr.io token + `HEAD /v2/anton4/emhass-lens-<arch>/manifests/<version>` (arch from `platform.machine()`); `UpdateInfo.released_version` / `store_path`; header chip "x.y.z released · Check for updates" (to `/hassio/store`) while the Supervisor hasn't picked it up. A ready release isn't looked up again. Tests in `test_updates.py`; the world fakes GitHub and the registry.

### 2026-10-10 (evening): update available in the header (0.3.16)
- `services/updates.UpdateService` reads `/addons/self/info` (`version_latest`, `update_available`, `slug`) at start and every 30 min (job `app.update_check`, unrecorded); `StatusInfo.update` (`UpdateInfo`); `Layout.tsx` shows an "Update to x.y.z" chip linking to `/hassio/addon/<slug>/info` (`target=_top`, out of the Ingress frame). The API tests that run "under the Supervisor" now get the fake transport (they had made real requests to http://supervisor). Test `test_updates.py`.

### 2026-10-10 (evening): This slot judges only what the inverter controls (0.3.15)
- Owner's 18:15 slot: plan battery 1.57 kW discharge for 1.54 kW forecast load; house used 698 W; battery sensor counts charging as positive (needs Opposite sign). `domain/plan_now.battery_expected` (plan + Δload − ΔPV + Δdeferrable; the EV from the charger's limit while charging), `compare` judges grid vs plan, battery vs expected (`sign_hint` when opposite and ≥ 300 W), SoC; load and PV never judged. UI: no lamp for forecasts, expected value in the battery tile's hover, Opposite-sign notice.

### 2026-10-10 (evening): MQTT problem waits for the first connection (0.3.14)
- The owner's 18:06:33 "Problem: MQTT entities aren't being updated" had no detail, i.e. `last_error` was None: Health ran while the first connection was being made (MQTT had just been switched on). `OutputService.down_since` + a 2 min grace in `health_rules` (detail "still connecting to …" when there is no error yet); `explain_mqtt_error` (Supervisor: no Mosquitto App; CONNACK 4/5/134/135: login refused; refused/timeout/DNS: unreachable); `ProblemService.sync` logs a detail that arrives later. Tests `test_mqtt_health.py`.

### 2026-10-10 (evening): plan vs now on the Plan page, variant B (0.3.13)
- Design canvas "Plan page: plan vs inverter now" (variants A/B); the owner chose B. `domain/plan_now.py` (`row_for` = the newest stored plan holding the slot, i.e. the one published at its start; `power_differs` 300 W and 15 %; `soc_expected` interpolated through the slot; `compare`), `services/plan_now.py` (measured from the watched Measurements entities with scale/invert, inverter registers + `preconditions`, charger observed), `GET /api/plan/now` (`PlanNow`). Frontend `pages/plan/NowSlot.tsx` replaces the old "This slot" card: tiles with a "now" line and amber edge (`ThisSlot` `now` prop), "Inverter set to" strip, Next slot toggle; `lib/planNow.ts`. Tests `test_plan_now.py`, `lib/planNow.test.ts`.

### 2026-10-10 (evening): solver time budget and retry; MPC at :11 (0.3.12)
- **Why:** run 985 (14:13, 223 slots, comparison on): cost 44 s and self-consumption 8 s solved, the live profit solve ran 91 s and EMHASS recorded `error` with no message: HiGHS stopped at the owner's `lp_solver_timeout` 55 s (`user_limit`), EMHASS's relaxed retry under the same limit didn't reach "Optimal" either (`optimization.py`). EMHASS kept the self-consumption plan (0.3.9 leftover guard held it back), the plan went stale and the inverter followed the older plan's grid import.
- **Done:** `domain/mpc/solver_budget.py` (deadline = next publish, or the one after when < 60 s; `limit_for` = (left − 10 s) × share / 2.2, capped 180, none under 15; live 0.6, comparison steps ≤ 30 s at 0.15; `timed_out`, `explain_error`, `http_timeout`); `MpcService.send` sends `lp_solver_timeout` and retries a timed-out solve once with `lp_solver_mip_rel_gap = retry_mip_gap` (artifacts `request_retry`, `response_retry`, `emhass_last_run_retry`); `_alternatives` sends short limits; settings `emhass.mpc.solver_budget` (auto/emhass), `retry_mip_gap` 0.05; `slot_offset_s` default 660 with migration v3→v4 (780 → 660). Both keys are runtime parameters in EMHASS (`data/associations.csv`, `runtime_solver_opts`). Plan page note explains an error without a message from `stage_times`. "Kept in sync" text no longer overflows (`.facts` cells may shrink, lamp labels wrap there).
- **Verified:** `test_solver_budget.py`, `test_solver_retry.py`, migration test; 322 backend, 91 frontend tests.

### 2026-10-10 (evening): kept in sync every minute (0.3.10)
- `domain/drift.py` (`DriftTracker`, `assess` → ok/settling/watch/correct/fighting: settle after own write, seen twice ≥ 30 s apart, 3 corrections per field per hour then a 1 h pause; `describe`). Inverter: job `inverter.verify` (`Periodic(60, 30)`, unrecorded) compares `sofar.observed()` with this slot's applied targets and starts `inverter.decide {"drift": …}`; also re-decides a slot refused for a transient reason. Charger: `tick_job` → `_drift_handled` when the decision targets the limit EMHASS Lens last set (`last_applied`) but the charger shows another; settle 90 s. Settings `inverter.drift_check`, `charger.drift_check` (on). Health `inverter.fighting`, `charger.fighting`; `DriftStatus` on both status endpoints and a "Kept in sync" fact on both pages.
- **Verified:** `test_drift.py`, drift tests in `test_inverter_service.py` and `test_charger_service.py` (40 clean repeats).

### 2026-10-10 (evening): catch-up after Home Assistant comes back; header problem link (0.3.10)
- **Why:** with Home Assistant down at :15 the publish fails, the inverter decision is refused ("not connected") and nothing retried the slot, so the inverter kept the previous slot's settings for up to 15 min; a restart also drops `sensor.p_*`. A host reboot gave the same result (first fire after start is the next quarter).
- **Done:** `services/catchup.CatchUpService` on `ha.on_connect` (live MPC, App driving, no market hold): publish with `chain_inverter/chain_charger=False` when this slot wasn't published or `sensor.p_batt_forecast` is gone, then `charger.decide` and `inverter.decide` with `catch_up`; retries every 20 s (≤ 15 tries, within the slot) while `InverterService.refusal_this_slot()` is `transient_block` (entity missing/unavailable/unknown, not connected). `InverterService.last_refusal`, `applied_this_slot()`. Header "N problems" links to `/health?focus=problems` (scrolls to `#card-problems`, titles on hover).
- **Verified:** `tests/test_catchup.py` (40/40 repeats), full suites green.

### 2026-10-10 (evening): automatic fit, leftover comparison plans, charger numbers, sensor rounding (0.3.9)
- **Automatic fit:** `domain/ml_schedule.auto_fit_due` (night window from `emhass.ml.auto_fit_hour`, 3 h, crosses midnight; daily/weekly/off; fault fit at most every 6 h); `MlService.after_mpc_run()` from `MpcService.run` starts `ml.fit` with `{"auto": reason}` after the job lock frees, only when the App drives EMHASS; kv `ml.auto_fit`. Closes PLAN.md's "optionally weekly".
- **Leftover comparison plans:** EMHASS's plan store keeps the last good plan, so a failed live run after a comparison left the last alternative there; the plan watch stored it as `external` with the failed run's status (the owner's "Made for someone else" + "EMHASS error"). `CostfunCompareService.leftover` (kv `costfun.leftover`) now keeps it out of `watch_plan` and `publish`, health `costfun.leftover`; cleared by the next good live plan. The Plan page shows EMHASS's `error_message` and explains `external`.
- **Charger numbers:** `domain/charger.numbers()` appended to every decide summary after " · "; `parseChargerSummary` returns action and facts.
- **Sensor rounding:** the owner's Nord Pool sensor (`..._3_10_0`) rounds the spot to 3 decimals; `price_compare.compare(spot_decimals=, vat_factor=)` rounds ours the same way (`prices.sensors.spot_decimals`, default 3). Export becomes equal; import shows the template's Võrk 2 rates (6.08 / 3.50 c) against the App's Võrk 4.
- **Verified:** 301 backend tests, 88 frontend tests.

### 2026-10-10 (evening): a tuned load model cuts the horizon instead of stopping MPC (0.3.8)
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
