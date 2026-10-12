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
2. Whether Server-Sent Events stream through Ingress without buffering (the status chip's panel says "Live updates" when they do). If they don't, every page keeps its timers and the Logs page polls `/api/logs` every 5 s (since 0.3.20).
3. Whether Mosquitto is installed (needed for Phase 3).
4. Your live tariff values: Võrk 4? Is excise 0.21 c or 0.307 c?
5. The Elektrilevi night window in summer: wall-clock 22–07, or winter-time 23–08?

## Log

### 2026-10-12: inverter rules: one "chosen now", a clearer list, battery caps at the plan (unreleased)
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
  - `AgreementFact` (with a bar), `CompareChip`, and `DayStrip` (built by `lib/dayStrip.ts`: `stripItems`, `stripLabels`, `stripRuns`, `holdUntilNext`) for "Today, slot by slot" (decision by decision for the charger and the market).
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
