# Changelog

## 0.4.26

- Plan: the **Battery** and **EV** boxes in This slot show the state of charge beside the power. On a phone it goes at the end of the line under the power.
  - Battery: the measured state of charge, amber when it differs from the plan. Previous slot shows the quarter-hour mean. Next slot, or a slot with no SoC sensor, shows the plan's state of charge for the end of the slot.
  - EV: the car's battery level from Settings → EV charger control → Charger entities → Car battery level, with the target in the hover text. It shows on This slot while EV charger control isn't Off.
- API: the `charger` block of `GET /api/plan/now` has `soc` and `target_soc` (%).

## 0.4.25

- Market: during a sell, the feed-in limit is changed only when it has to be. While selling, the inverter exports the lower of the grid target and the feed-in limit.
  - A limit at or above the command is left as it is. A lower one is raised to the sell cap at once, instead of waiting out the feed-in cooldown while the market gets less than it asked for.
  - The limit follows the command only when the battery can't take the spare PV: it is at or above the new threshold **Sell: the battery can't take spare PV from** (97 %), and PV minus the house load exceeds the command by more than the deadband.
  - In the Kratt session of 13 October the limit would have stayed at 15500 W. That makes 10 inverter button presses instead of 17, with no feed-in presses, and about 60 % less under- and over-delivery.
  - Each decision on the Market page says what the automation would have written. In Shadow a sell's feed-in limit isn't compared.
- Settings: Qilowatt market control → Market entities → **House load now** (default `sensor.sofar_active_power_load_sys_watt`). The Market page shows it beside the battery and PV.
- Market (Shadow): the minute check judges the cooldown at the automation's own minute tick, 15 s earlier. A cooldown that ran out in between no longer shows as a mismatch.
- Market: the session watchdog logs its reports (long session, EMHASS left off, Shadow's would-clear) on the Logs page; a run with nothing wrong reads "All clear: …".

## 0.4.24

- Market: a **session watchdog** takes over from the Home Assistant automation "Qilowatt: Session Watchdog". It runs every minute as its own job, separate from the market control.
  - In Live, it ends a session whose source has been gone for 10 minutes, if the market control didn't end it itself, for example because `input_boolean.qilowatt_automation` was turned off mid-session. The session select goes back to `none`, the EMHASS switch comes back on and the inverter is handed back to the plan, or set to self-use when there is no fresh plan. Only the registers that differ are written.
  - It sends a phone message about a session open for 3 hours, and about the EMHASS switch left off for 10 minutes with the inverter in Force charge or Force discharge but no session open.
  - In Shadow it only records what it would clear.
  - Its findings show on the Health page and as a **Watchdog** fact on the Market page.
  - Its settings are under Settings → Qilowatt market control → Session watchdog.
  - Once market control is Live, turn off "Qilowatt: Session Watchdog" together with "Qilowatt: Master Market Controller", and turn on **Watchdog** on the App's Info tab.
- Market: when a session ends without a fresh plan to hand back to, the inverter's state select is set to self-use even if the registers were already safe. The App and the watchdog can no longer both end the same session at once.
- API: `GET /api/market` has a `watchdog` block.

## 0.4.23

- Inputs: a new **What EMHASS gets** section at the top charts everything the newest MPC run sent, from its anchor to the end of the horizon. It shows the import and export prices with the tariff period and export limit under them, the Solcast PV forecast and its P10 with each day's total in kWh, and EMHASS's house load forecast with each deferrable load's window. It also shows the battery's state of charge now and its target. Cards sum it up with the payload keys they stand for. **Preview now** shows a payload built now instead, without sending it.
- Inputs: **Before the anchor: 24 h measured** puts the last day as measured in front of it: the house load from your load sensor, PV and the battery. Pointing at any chart shows the Plan page's popup on every chart at once.
- API: `GET /api/inputs/sent` (the newest run's payload slot by slot, with EMHASS's load forecast and `hours_back` hours measured) and `POST /api/inputs/sent/preview`.

## 0.4.22

- Settings: a button entity shows when it was last pressed in the App's timezone, e.g. "pressed Mon, Oct 12, 13:15:02". Before, it showed Home Assistant's UTC time as stored (`2026-10-12T10:15:02.322394+00:00`), three hours off in Tallinn's summer. This covers the inverter's apply and feed-in buttons, the EV charger's start and stop buttons, and timestamp sensors.
- Health: the HACS settings import is gone. That is the *Settings imported from the HACS integration* step under Getting started, the *Import from the HACS integration* card, and the `/api/legacy/preview` and `/api/legacy/import` endpoints. Enter tariffs under Settings → Prices and the API key under Settings → Price forecast.

## 0.4.21

- Inverter: when export is allowed, a feed-in limit that already lets out what can reach the grid is kept instead of being rewritten to the export max. That covers the plan's export or spare PV, rounded up to 100 W. A limit a market sell session left behind (e.g. 3000 W against 2770 W of spare PV) no longer costs a feed-in button press, and the drift check doesn't set it back. A lower limit is still set to the export max. Cheap slots still get 0 W, and slots where the plan curtails PV get the export max.
- Market and EV charger: the day strip shows one mark per stretch of the same decision instead of one per decision. Pointing at a mark shows a popup with the time range, what was decided and how many decisions agreed with the automation.

## 0.4.20

- Runs: the job and outcome filters each open a list where you tick any number of jobs or outcomes. **Include** shows only the ticked ones and **Exclude** hides them, for example every job but the heartbeat, or every outcome but OK and Nothing to do. The jobs are listed A–Z. Links to one job (`?job=emhass.mpc`) still work.
- API: `GET /api/runs` takes `job` and `outcome` more than once, and `not_job` and `not_outcome` to leave runs out.

## 0.4.19

- Market: with Qilowatt market control on **Shadow**, EMHASS Lens holds off the inverter while the automation runs a session and re-applies the plan the moment it ends, with at most one inverter write. It follows the market's *Session state select*, so there is nothing to turn on under Market session hold. Before, the feed-in limit a sell session left behind stayed until the drift check set it back a minute or two later.

## 0.4.18

- Inputs: **What the import price is made of** is a column per quarter-hour instead of one filled area. Spot, fees, network and VAT are stacked with a hairline between them and a gap between quarter-hours, and the import price is a dark cap on top; when spot is below zero, the cap sits inside the column. Spot is a darker grey and fees a stronger violet, so the two no longer run together. Forecast quarter-hours are faded.
- Inputs: pointing at either price chart rings that quarter-hour's column, and both charts read the quarter-hour the pointer is in. Before, the right half of a quarter-hour showed the next one.

## 0.4.17

- Inverter: **How a rule is chosen** tags only the rule that matched. Before, "Self-use" slots tagged rules 7 and 9 at once, because both end in the same mode. The rules are grouped by what the plan's grid power picks (importing, exporting, neutral), still numbered 1–9, and each has a title of its own (three of them were all "Self-use battery or PV").
- Inverter: when the plan imports and discharges in the same slot (*Use the battery, import the rest*), the battery gives what the plan says and the grid covers the rest. Before, the battery covered the whole house and used up energy the plan had saved for a dearer slot.
- Inverter: when the plan exports and charges in the same slot (*Charge and export*), the battery takes what the plan says and the rest is exported. Before, the battery took all the surplus PV and nothing was exported. Never in a slot at or below *No export at or below*.
- Inverter: a cap is set at the plan + 250 W and kept while it stays 0–500 W above the plan, so small changes in the plan don't press the apply button (an EEPROM write). New under Settings → Inverter control: the two caps (both on; off does what the automation does) and **Battery cap slack** (500 W). *More about decisions* lists where EMHASS Lens differs from the automation.

## 0.4.16

- Inputs: the price chart and the price breakdown are one Prices section, the breakdown right under the prices on the same time axis (every day loaded, not one day at a time). Point at either and both show a popup for that quarter-hour: import, export and spot with Nord Pool or the forecast's source, and spot, fees, network and VAT with the rate and the import price under a rule.
- Inputs: **All days**, **Yesterday**, **Today** and **Tomorrow** zoom both charts together and pick the day of the table; drag to zoom in, double-click to see every day again.
- Inputs: the breakdown is in the Plan page's violets (fees, network and VAT from light to deep, spot grey), with the import price as a line on top. Prices show 3 decimals in €/kWh.

## 0.4.15

- Plan: point at a chart and every chart shows a popup at that moment with each line's value, instead of the legend under it changing. It names the quarter-hour and whether it is measured or plan; for prices whether it is Nord Pool's or a forecast, and whose (for example "Forecast (eupowerprices.com)").
- Plan: in the past each popup row has the measured value and, on a shaded band, what the plan said then (the dashed lines). The chart under the pointer rings the line nearest it. On a phone only the chart you touch shows its popup, across its top.
- Plan: battery and grid values carry their sign: the battery **+** when charging and **−** when discharging, and the battery line is now drawn that way up ("Battery (+ charge)"), the grid **+** when importing and **−** when exporting. Prices in the popups have 3 decimals.
- Plan: the charts are taller (power 300 px, state of charge and prices 210 px), and the legend is a plain key that no longer jumps as you move.
- Colours: the battery state of charge is teal, so it no longer looks like the battery's power, on the charts and in This slot. Import and export prices are a deep and a light violet, both solid lines, on the Plan and Inputs pages.

## 0.4.14

- The pages are tabs under the top bar again, instead of a sidebar, so every page gets the full width (the content may now be up to 1440 px wide). The tabs keep their groups (a thin line between them), the "exp" tags and Health's problem count; on a phone they scroll sideways. The update link moved next to the name.
- Plan: **This slot** is redesigned as a flow: PV at the top, the grid on the left, the battery on the right, the house and the EV below, with lines as thick as the power that point the way it flows. A line at the top says what happens ("Charging the battery from the grid"), next to the inverter's passive mode in its Inverter-page colour and an "as planned" or amber "Battery and grid differ from the plan" chip; when reality differs, the plan's own line follows ("Plan: the battery covers the house").
- Plan: what is measured is now the big number in each box, and the plan the line under it ("plan 12.69 kW"). Each box shows how long ago its sensor last changed, and the panel's title when the page last read the values; it reads them every 10 seconds, and at once when a plan is published or the inverter or charger acts. The EV box shows the charger's power while it charges (its current limit) and its state.
- Plan: beside the flow, the battery's state of charge with the plan's range for the slot as a bracket and EMHASS's minimum state of charge hatched, and the slot's prices with where the import price sits among today's ("cheap for today").

## 0.4.13

- Inverter: one battery minimum for every mode that may discharge. **Battery min while force charging** (−3000 W) and **Battery min while exporting PV** (−16000 W) are gone; Force charge and Self-use PV and export excess to grid now use **Battery discharge max (negative)** (−20000 W by default) like the other modes. Use only grid power still keeps 0 (it may charge, not discharge). In Force charge the grid target is the import max, so the battery only discharges to hold the grid at 18.8 kW when the house uses more than that plus PV; in Self-use PV and export the battery only covers a house load above the PV. The first Force charge slot after the update writes the new minimum once. Your stored settings are migrated automatically.

## 0.4.12

- Inverter: **Force charge** sets the grid target to the import max (Grid import max, 18800 W by default) in every slot, and the battery limits its own charge. Before, the target followed the plan's P_grid below 9000 W, so two Force charge slots in a row pressed the apply button again just to change the grid power (02:00 set 18800 W, 02:15 set 4800 W), and every press is an EEPROM write on the Sofar. Back-to-back Force charge slots now write nothing ("Already set"). The battery may charge faster than the plan in a slot where the plan wanted only a little; the next quarter-hour's plan starts from the real state of charge. To follow the plan's P_grid like the automation, turn off **Force charge at the import max** under Settings → Inverter control → Limits and thresholds.

## 0.4.11

- Inverter: **Today, slot by slot** is coloured by the passive state each slot set, so you can see where the mode changes: force charge blue, use only grid power slate, self-use lavender (dotted where export is restricted), charge battery and export striped, PV export aqua and force discharge orange. Slots where EMHASS Lens wasn't in control (for example an mFRR session) are hatched. A key above the strip counts the slots per state. In live mode the strip used to be all grey, because only dry run compares with the automation.
- Inverter: point at a slot (or tap it on a phone) to see what it set on the Sofar inverter: passive state, grid power, battery min, battery max and feed-in max. Values that changed since the slot before are tagged, a feed-in limit left as it is shows the last one set and since when, and in dry run a row turns amber with what the automation set where it differed. Click the slot to open its decision, as before.
- Inverter: the line under the strip shows the comparison in dry run (light green the same, amber different) and the slots that wrote to the inverter in live.

## 0.4.10

- MPC: EMHASS's **battery charge power derating** (`battery_charge_power_derating`) is left out of the plans. EMHASS gives every derating step a yes/no variable per slot. With two steps, a 52-hour plan took the solver over 2 minutes on the HA host (20 s instead of 0.3 s on a fast computer), so runs stopped at their time limit with no plan, often several in a row in the evening. The battery's BMS tapers the charge anyway, and every quarter-hour's plan starts from the real state of charge. To plan with it anyway, add `battery_charge_power_derating` under Settings → EMHASS → Extra runtime parameters.
- MPC: a solve that stops at its time limit is retried with a 5 % MIP gap again. EMHASS 0.18.5 answers such a run with an error (HTTP 400), and the retry only expected a normal answer, so it never ran. The run's error now says that the solver stopped at its time limit, instead of quoting EMHASS's last log line.
- Publish: a failed MPC run no longer makes the quarter-hour publish fail too. Live runs ask EMHASS to save the plan's sensors (`entity_save`), a failed run leaves them alone, and the publish then has EMHASS post the last good plan again (`publish_prefix: all`). The `sensor.p_*` values, the plan-published event (with `republished_because`), the inverter and the EV charger all follow that plan. Once it is older than the plan max age (Settings → Health, 30 min by default), the publish is refused with the reason and nothing is sent to EMHASS. The same applies when a cost-function comparison left its plan in EMHASS.
- Plan: the **Previous slot / This slot / Next slot** switch stays in place when you click it. It used to sit right after the title, so it moved whenever the title and time range changed length; now it sits at the panel's right edge like the other panels' controls.

## 0.4.9

- Prices are in €/kWh everywhere again: the Plan page (this slot's tiles, the price chart and the plan table), the run page's publish event and the Inverter page. The Inputs page still has its c/kWh switch, but now starts at €/kWh.
- Inputs: switching the price unit now updates the chart's axis and legend too. Before, the legend stayed in c/kWh and every axis label read "0 c" after switching to €/kWh.
- Plan: **How accurate the plan has been** fits without scrolling. It has one column per window (last 24 h, last 7 d), with the bias under each error.
- Plan: the facts row shows the **Total cost function**: the sum of the plan's cost function over its horizon, which EMHASS publishes as `sensor.total_cost_fun_value`.
- Plan: **Previous slot** next to This slot and Next slot shows the plan for the quarter-hour that just ended, next to its measured quarter-hour means.

## 0.4.8

- Inverter control: the feed-in limit is only written when something can reach the grid in the slot. That means the plan exports, curtails PV, or has PV to spare while the battery is nearly full (new setting **Battery counts as nearly full at**, 90 %). Otherwise the limit is left as it is, because every press of the feed-in button is an EEPROM write. Before, a slot like 08:15 with 300 W of PV and the battery at 73 % pressed it just because the export price crossed the threshold, and prices around the threshold flipped it up to 10 times a day. The limit's value still follows the export price. A limit left as it is shows *unchanged* with the reason, and the drift check doesn't set it back.

## 0.4.7

- Inverter control: the battery window is now labelled in Sofar's sign, where charging is positive. In Settings, its top is **Battery charge max** and its bottom **Battery discharge max (negative)**. The rule list says *Use only grid power* lets the battery charge but not discharge (PV first, the grid covers the rest), and *Self-use PV and export excess to grid* lets it discharge but not charge. Both used to say the opposite. The values written to the inverter are unchanged.

## 0.4.6

- Run pages of EMHASS MPC and cost-function comparison runs show a **Pipeline**: building the payload, each EMHASS call (the compared cost functions, the live one with EMHASS's own stages and solve time) and reading back, as bars on one time axis, with the step that failed marked. Older runs show it too, placed from when each call ended. Other jobs are a single step and show none.
- Each EMHASS call now records when it was sent, so the pipeline is exact for new runs.
- Price breakdown: spot keeps its grey, and fees, network and VAT are the import price's reds, from light to dark (as in design B).

## 0.4.5

- EV charger: a decision no longer appears twice around each publish. Both the publish and EMHASS updating its EV power sensor asked for one, about a second apart. Now a slot gets one decision per EV power value, whichever of them arrives first; a new value still decides again at once.
- Runs: the timeline is easier to read. It shows bars side by side, one per minute, 5 minutes or 15 minutes, each coloured by the most notable outcome in it (an error before a refusal before a dry run before OK), instead of a hairline per run.
- Runs: a **1 h / 6 h / 24 h** switch picks how far back the timeline reaches. It sits above the filters, counts the runs per outcome, and no longer depends on how much of the list is loaded.

## 0.4.4

- Inverter, EV charger and Market share one layout:
  - The mode switch sits at the top of the page (Off / Dry run / Live; Market: Off / Shadow / Live). It asks before changing anything, and switching to Live names the Home Assistant automation to turn off first. Each change is a settings revision, so it can be reverted.
  - Under the switch, one line says what the mode does, then a facts row: who is in control, the agreement over 24 hours and 7 days (with a bar), and the page's own facts.
  - **Today, slot by slot** (decision by decision for the charger and the market): green where the automation did the same, amber where it differed, grey where nothing was compared, with the rule named where it changes. Click a mark to open the decision.
  - **How a rule is chosen** lists the rules, branches or guards in the order they are tried and tags the current one. The details (thresholds, arithmetic, modes) fold away under "More about decisions".
- Price breakdown: spot keeps its own colour (grey, as on the price charts) and what is added on top of it is in greys, so no part borrows the battery, grid, EV or PV colour. The parts' switches are pills.

## 0.4.3

- The EMHASS plan can avoid exporting below a price. Settings → EMHASS → MPC optimization → **No export at or below** (€/kWh) sends EMHASS a per-slot export limit of 0 W in slots whose export price is at or below it. EMHASS then charges the battery or curtails PV instead of exporting, and doesn't discharge the battery to the grid. This works with every cost function and needs EMHASS 0.16 or newer with `compute_curtailment` on. Health → EMHASS checks both.
- The setting replaces Inverter control's "Block export at or below this price" and keeps its value (0.03 €/kWh unless you changed it). **The plan stops planning exports at or below that price right after the update.** Clear the setting to go back to planning exports at every price; the inverter's feed-in limit then never blocks either.
- The Explain table shows an *Export max* column when some slots are blocked.

## 0.4.2

- Inputs: the price breakdown table (96 rows a day) is folded away under its chart; open it with "Every quarter-hour as a table".
- Runs on a phone: each run is a compact card (run, job, outcome, when, how long, summary) instead of a six-column row.

## 0.4.1

- Plan: the plan in one line at the top ("Discharging the battery until 21:30, then idle · SOC 94 % → 38 %"), the facts in one row, **Chart / Table** for the whole plan, This slot / Next slot as a switch, and each tile marked with its chart colour.
- Plan: the **MPC runs** sit under the charts on the same time axis, coloured by outcome; click one to open it. The line under them counts the runs per outcome and shows when the next is due.
- Plan: prices in c/kWh with one decimal (tiles, chart and table). The table names its columns in words (Battery, Grid, Import price, …) with EMHASS's names under them, and shows power in kW and SOC in %.
- Plan: How accurate the plan has been and Changes vs the previous plan sit side by side.
- Runs: a timeline above the list shows the listed runs in a lane per kind of job. On a wide screen a click shows the run beside the list instead of leaving the page.
- Run pages have tabs: Summary, Artifacts and Logs (the tab is part of the address).
- Health: links at the top jump to each section and stay in view while you scroll.
- Settings: a changed field shows its saved value next to it ("was 45 s"); secrets never do.
- Logs: a strip counts the lines per 5 minutes over the last 3 hours, with warnings and errors marked.

## 0.4.0

- A new look: Home Assistant's blue and cool greys on a white page, the Geist typeface (bundled with the App, nothing loads from the internet) and sections without boxes. Dark mode follows the system as before.
- The pages sit in a sidebar, grouped into Operate, Control, Diagnose and Configure. On a phone the sidebar opens from the menu button.
- The row of status lamps is now one chip at the top ("LIVE · EMHASS Lens drives"). Click it for the mode switch, the next MPC run, every part's state and the live-update connection. A "N problems" chip next to it opens the problem list.
- **Run MPC now** is in the top bar on every page.
- **⌘K** (Ctrl+K) opens a palette to jump to any page, settings section or run by typing; **g** then a letter opens a page.
- Notices under the top bar show one at a time, with **+N more** for the rest.
- Charts give every quantity its own colour on every page: battery blue, grid orange, PV yellow (drawn as an area), house load pink, EV and deferrable loads green-blue, import price red, export price green and dashed, spot grey and dotted.

## 0.3.20

- The Logs page keeps showing new lines when the live connection isn't getting through (the amber "Polling" lamp in the header). It asks for them every 5 seconds.
- An open run that is still running shows its log lines as they arrive, and its outcome as soon as it finishes.
- Lists showing a day that has ended no longer reload on every job, which saves the App up to 2000 rows of work several times a minute.

## 0.3.19

- Recent decisions and slots on the EV charger, Inverter and Market pages, and the Market sessions, can be filtered and sorted. Pick a day (or step day by day), search, narrow to one rule or branch, keep only the mismatches with the automation, and click a column header to sort.
- Runs has a time range (From and To in Home Assistant's time zone, plus Today and Yesterday) and sortable columns.
- Times in these lists, the Plan page tables, the price table, the parity examples, the cost-function comparisons and the problem history now show the date, for example "Sat, Oct 10, 18:15".
- The cost-function comparisons and the problem history sort by any column.

## 0.3.18

- Chart legends keep their rows when the values change: every value takes the same width, so the charts below no longer jump up and down as the cursor moves.

## 0.3.17

- The header also checks GitHub: once a new release's image for your machine is built, it shows **x.y.z released · Check for updates** until Home Assistant's App store picks it up.

## 0.3.16

- The header shows **Update to x.y.z** next to the version when Home Assistant can install a newer EMHASS Lens (checked with the Supervisor every 30 minutes and at start); it opens the App's page in Home Assistant.

## 0.3.15

- Plan page, This slot: house load and PV are shown but no longer judged (they are forecasts). The battery is judged against what the plan means for the house load, PV and EV charging now, so a house using less than forecast no longer marks the battery amber. When the battery runs the other way than expected, the card points to *Opposite sign* for the battery sensor.

## 0.3.14

- MQTT: Health no longer warns while the first connection is being made (after a start or after switching MQTT entities on); after 2 minutes without a broker it says why (no Mosquitto broker App, login refused, broker unreachable), and the log line carries that reason too.

## 0.3.13

- Plan page: **This slot** now shows the plan row in force for the current quarter-hour (not the next one in the last minutes of a quarter), with a **Next slot** button. Each tile shows what is measured now next to the plan, with an amber edge when they differ, and a strip below shows what the inverter is set to (mode, grid target, battery window, feed-in limit, when it was written) or why EMHASS Lens isn't in control.

## 0.3.12

- EMHASS's solver gets a time limit per optimisation from the time left before the next publish (the live plan most of it, cost-function comparison steps at most 30 s), and a live solve that stops at its limit is retried once with a 5 % MIP gap, so EMHASS ends with a live plan instead of a comparison plan. A solver error without a message is explained ("stopped at its time limit"). Settings → EMHASS → MPC optimization → *Solver time limit*.
- MPC now runs at 11:00 into each quarter instead of 13:00, for about four minutes of solver time; a changed time is kept.
- "Kept in sync" no longer runs into the next column on the Inverter and EV charger pages.

## 0.3.11

- The Plan page shows prices in €/kWh instead of cents: the price chart, the import and export price of this slot, and the price forecast's error on the accuracy card.

## 0.3.10

- When Home Assistant comes back (a restart, a host reboot or a lost connection), EMHASS Lens catches up the current quarter-hour in live mode: it publishes again, which restores EMHASS's `sensor.p_*`, and sets the EV charger and the inverter for the slot it missed instead of waiting for the next one. It waits for the inverter's entities while Home Assistant is still starting.
- The red problem count in the header links to Health → Problems and lists the problems on hover.
- Kept in sync every minute (live mode): the inverter's passive-mode settings and feed-in limit, and the EV charger's current limit, are set back when something else changed them. Never right after EMHASS Lens's own write, only when the difference is seen twice, and after 3 corrections of the same setting within an hour EMHASS Lens stops for an hour and Health says something else keeps changing it. The Inverter and EV charger pages show *Kept in sync*; both can be turned off in Settings.

## 0.3.9

- EMHASS Lens now fits EMHASS's load model by itself: every night right after the first MPC run from 03:00 (or weekly, or off), and right after the next run when the model can't serve the runs (a short tuned model, changed lags). Only while it drives EMHASS; it never tunes.
- When the live run after a cost-function comparison fails, EMHASS holds the comparison's last plan. EMHASS Lens no longer stores it as "someone else's" plan or publishes it, and Health says what happened.
- The Plan page explains an EMHASS error (EMHASS's message, and whether the plan shown is older) and what "made for someone else" means.
- EV charger: Recent decisions show the new current and the numbers behind each decision (current before, PV, house load, surplus, or the plan's EV power).
- Price sensor check: the App's spot price is rounded like the Home Assistant Nord Pool integration's (3 decimals) before comparing, so rounding no longer shows as differences and a different network package is named again.

## 0.3.8

- A tuned ML load model no longer stops planning. EMHASS's tuner picks its own lag count (6 h to 3 days) and a tuned model forecasts only that far, so runs with a longer horizon failed with "Unable to obtain … lags_opt values". EMHASS Lens now recognises that answer, plans again at once with the horizon cut to what the model covers, and shows a Health warning until the model is fitted again. The Tune button explains this.
- EMHASS is shown as busy, not unreachable, while it computes an action for EMHASS Lens and its health check times out.
- A failed EMHASS action shows its error line instead of EMHASS's whole log.
- Fixed "Task was destroyed but it is pending!" log errors after a browser closed the live log stream.

## 0.3.7

- PV reserved for Excess Solar charging (Settings → EV charger control, off by default): while the car charges from excess solar, the PV forecast sent to EMHASS is reduced by what the charger is expected to take in each slot, until the car's charge to its target is covered, so EMHASS does not plan the home battery or exports with energy the car will use. The Explain table shows the reserved watts per slot; the EV charger page shows the current state.

## 0.3.6

- EV charger page: the charge mode (Manual / EMHASS / Excess Solar) can be switched from the page. The buttons set your Home Assistant helper, the same one the automation reads, and a decision follows at once while the controller is in dry run or live.

## 0.3.5

- Health no longer raises "No successful MPC run recently" the moment you take over: the grace for the first live run now counts from the take-over, not from when the App started.

## 0.3.4

- Settings → Prices → **Compare with your price sensors**: the parity check now also compares the App's import and export prices with your own Nord Pool template sensors (`raw_today` / `raw_tomorrow` / `raw_all`), slot by slot, and explains a constant difference, for example a template still on Elektrilevi Võrk 2 network rates while the App uses Võrk 4. The Health card is now called *Parity checks* and runs with or without the HACS integration.

## 0.3.3

- Settings → Measurements says which unit each sensor is expected in (W, or % for the state of charge) and how to convert a kW sensor.
- Settings: in the review before saving, long field titles wrap instead of running over the change text.

## 0.3.2

- **Storage.** Settings → Storage replaces Settings → Logging → Retention and adds a size budget per database (runs.db 300 MB, app.db 200 MB by default), compaction (VACUUM after cleanup when at least 20 % and 16 MiB of a file are free, or with *Compact now*) and retention for what never expired before: problem history (90 days), market sessions (180 days) and settings versions (newest 100, the current one always). Pinned runs keep their log lines. The nightly cleanup cuts in day-sized steps, checkpoints after deleting, and reports per table.
- Health → **Storage** card: both files with size, data in use, free pages and budget, the biggest tables, the last cleanup, free disk space, the newest Home Assistant backup that contains the App, and *Clean up now* / *Compact now*. New Health warnings: a file over its budget, less than 200 MiB free on the data disk, no recent backup with EMHASS Lens (Settings → Storage → "Warn when no backup for").
- **Backups.** Before a Home Assistant backup the App checkpoints `app.db` and checks its integrity (a damaged file aborts the backup); the add-on now has the Supervisor's `backup` role to list backups. After a restore the App notices the empty `runs.db`, continues run numbers after the ones `app.db` remembers and shows a "Restored from a backup" note. `docs/BACKUP.md` is the runbook; `scripts/restore-drill.sh` rehearses a restore from a backup file without Home Assistant.
- Run details are capped at 512 KiB each (bigger ones are kept as a note with a preview); the cost-function comparison no longer stores each plan twice.
- Shutdown: the UI's live event stream ends by itself when the App stops, so uvicorn no longer waits five seconds and logs a cancelled task on every restart.

## 0.3.1

- After a restart the price forecast is restored from the database together with its last poll time, so it is shown at once, no "forecast isn't available" warning appears, and eupowerprices.com is only asked again when the poll interval is due.
- Start-up no longer records a skipped EMHASS configuration check next to the one already running.
- Settings: long section titles wrap inside the navigation instead of running into the form; "Measurements" lost its parenthetical.
- Qilowatt market control: the *Fusebox sell power helper* is gone. It was a manual export override copied from the automation that nothing ever set; Fusebox sells now follow the commanded power like Kratt sells. Stored settings are migrated (schema 2).

## 0.3.0

- Plan page: the charts now reach back in time. Left of the now line they show what was measured (solid) next to what the plan said at the time (dashed); **History** picks 6 h to 7 days, **Compare with** picks the plan in force or the one made 1, 6 or 24 h earlier. A new **How accurate the plan has been** card gives the error and bias per quantity over 24 h and 7 d, plus the price forecast's error against Nord Pool.
- Settings → **Measurements**: the sensors for grid, battery, PV, house load and SOC, with a sign switch and a scale each. Measured quarter-hour means are read from Home Assistant's recorder every quarter-hour (run *Measurements*) and backfilled after a start or a change (run *Measurement history*); Health warns when a sensor is missing or nothing has been read for an hour.
- Settings → EMHASS → MPC optimization → **Cost function**: ask EMHASS for profit, cost or self-consumption on every run (EMHASS 0.18+; Health warns if EMHASS ignored it).
- Plan page → **Cost functions**: *Compare now* runs the MPC with all three cost functions for the same inputs and shows each plan's net cost, import, export, self-consumption, battery use, end SOC and EMHASS's objective total, one chart overlaying the three plans (each switchable), and the earlier comparisons. **Compare cost functions on every run** does it before every live plan. The method in use always runs last, so EMHASS keeps the real plan.
- `app.db` grows: measurements (kept 120 days by default), per-slot rows of stored plans (14 days) and cost-function plans (30 days).
- Inverter control: the rules now follow the current, template-based version of the automation "EMHASS: Consolidated Inverter Control": ±100 W bands for grid and battery power, "Charge battery and export some to grid" can match, PV export depends on the export price, and the feed-in limit depends only on the export price. Every combination of grid and battery power now maps to a mode. Rule ids are the automation's mode names (`force_charge`, `self_use`, …).
- Settings → Inverter control → Limits: "Block export at or below this price" replaces "Block export below this price" and now defaults to 0.03 €/kWh. An existing install keeps its stored value; set it to the automation's value by hand.
- DOCS: a section on inverter control and how to move the automation over.
- Market session hold (Settings → Market session hold, off by default): while a market automation's session entity (e.g. `input_select.qilowatt_session_state` at `buy`/`sell`) says someone else drives the inverter, MPC runs are built but not sent, the plan isn't published and the inverter isn't touched. When the session ends, EMHASS Lens waits for the inverter enable switch to come back, publishes the stored plan once and decides the inverter from it, writing only what differs. Optionally MPC runs again afterwards without a second inverter write. New `binary_sensor.emhass_lens_hold`, a *Market session hold* row on the Driver card, and the run *Resume after a market session*.
- EV charger control (experimental, Settings → EV charger control, off by default) and an **EV charger** page: EMHASS Lens decides for the charger the way the automation "EV Charging: Combined EMHASS & Excess Solar" does (the target-SoC stop, EMHASS mode following the plan's EV power, Excess Solar mode following the PV surplus). Dry run records each decision with the calls and the phone message it would make and compares with what the automation did; live mode drives the charger and reads it back. Runs: *EV charger decision*, *EV charger comparison*, *EV charger check* (every minute) and *EV target SoC stop*.
- Settings → Notifications → **Mobile notify service**: where phone messages go (e.g. `notify.mobile_app_my_phone`).
- Qilowatt market control (experimental, Settings → Qilowatt market control, off by default) and a **Market** page: EMHASS Lens runs Kratt/Fusebox sessions the way the automation "Qilowatt: Master Market Controller" does, with the same guards against needless inverter writes (hysteresis, deadband, cooldown). Shadow mode decides on every command change and every minute and compares with what the automation did; live mode runs the sessions, keeps the session select and the EMHASS automation switch like the automation, and hands the inverter straight back to the plan when a session ends (one write). Sessions survive a restart; "End session now" is the kill switch.
- One writer for the Sofar passive-mode registers, shared by inverter control and market control: minimal calls, readback, a commit log (the cooldown survives a restart) and a count of apply/feed-in button presses (inverter wear) on the Market page.
- Scheduler: runs started by an event are always recorded; a level-triggered job can queue one rerun instead of being skipped.
- EMHASS 0.18.x support (verified against 0.18.3 and 0.18.5):
  - **P10 PV estimate** (EMHASS 0.18.4): every MPC run also sends Solcast's pessimistic P10 series next to the forecast (`pv_power_forecast_p10`), so EMHASS can plan more conservatively on uncertain days through its `weather_forecast_pv_quantile_bias` setting. On by default (Settings → PV forecast → *Send the P10 estimate too*); only sent to EMHASS 0.18.4 or later and never while the estimate itself is P10. The run's Explain table shows the P10 column, and the Health page's EMHASS card says whether EMHASS actually blends it.
  - **Running now** (EMHASS 0.18.2): Settings → Inputs → Deferrable loads has *Running now when* (an entity, e.g. the charger's state sensor) and *Running states* (e.g. `4`). When set, the run tells EMHASS which loads are already on (`def_current_state`), so it plans them as running instead of scheduling a fresh start.
  - **More than one battery** (EMHASS 0.18.0): the Plan page, the slot tile and the published event read the per-battery `SOC_opt_0`, `SOC_opt_1`, … columns, and the configuration check warns that EMHASS Lens still sends one SOC pair.
  - Configuration check: EMHASS 0.18.5 is now the recommended version (DST-safe MPC horizon and forecasts, `Optimal_Inaccurate` solutions count as ok); a hint about `publish_horizon_attributes` (EMHASS 0.18.2), which can be turned off in EMHASS to keep Home Assistant's recorder small because EMHASS Lens reads the plan from the API.
  - e2e: EMHASS 0.18.5 is the default image; a check for the P10 companion.

## 0.2.10

- Parity: when only the slots filled from the price forecast differ because the two sides fetched the forecast at different times, the check passes and says so, with both fetch times. Differences in Nord Pool prices are still reported.
- Health → Getting started: the "open" links to cards on the Health page now scroll to that card instead of doing nothing.

## 0.2.9

- Inputs → Price breakdown: click Spot, Fees, Network or VAT in the legend to show or hide that part; the chart rescales to what is shown and remembers the choice in this browser.

## 0.2.8

- The eye button on secret fields (the eupowerprices.com API key, the MQTT broker password) can also show the stored value. It works only when EMHASS Lens is opened from the Home Assistant sidebar, and each reveal is logged without the value.

## 0.2.7

- Plan charts: each y-axis fits its own data (Battery SOC is no longer always 0–100 %). Drag across a chart to zoom all three into that time range; double-click or "Reset zoom" shows the whole plan again.
- Secret fields such as the eupowerprices.com API key have an eye button that shows what you typed.

## 0.2.6

- Settings: the review before saving names each change by its place in the form; click one to jump to the field. Changed fields are highlighted, and each one can be reverted on its own, from the form or from the review. Discard all is also offered while reviewing.

## 0.2.5

- Saving settings and switching the mode work behind reverse proxies that only allow GET and POST (they failed with "Failed to fetch").
- After a start or update, Home Assistant shows the App as started within seconds instead of after a minute.

## 0.2.4

Fixes from a code review:
- **Nord Pool polling:** never runs more than once a minute, and backs off when an already-delivered day has no prices or the response is malformed.
- **Inverter control:**
  - decides right after EMHASS Lens publishes, and ignores EMHASS sensors left over from the previous slot
  - in live mode, re-reads the passive-mode and mFRR interlocks before writing, and refuses without a Home Assistant connection
- **MPC runs:** EMHASS's status is only trusted when its last run is newer than the request, and a missing plan read-back counts as an error.
- **MQTT:** entities show as unavailable when EMHASS Lens stops, and are removed when MQTT entities are turned off.
- **Take over:** a stale page can no longer leave nobody driving EMHASS.
- **Entity list:** only available through the Home Assistant sidebar (the optional direct port has no login).

## 0.2.3

- Entity fields in Settings search Home Assistant as you type: matches are listed best first with their current value, also on installs with thousands of entities.
- The log no longer shows every Home Assistant WebSocket message at debug level while the log level is info.

## 0.2.2

- Health page: a getting-started checklist that shows how far the move from the HACS integration is, step by step, with links.

## 0.2.1

- The Plan page's "This slot" shows the row EMHASS publishes right now (the next slot between a :13 run and the slot start) instead of saying the plan doesn't cover it.

## 0.2.0

The first version meant for trying on a real Home Assistant, next to the HACS integration.

- **Plan:** shows what EMHASS wants for this slot, with charts of power, SOC (and the previous plan) and prices.
- **Inputs:**
  - Nord Pool prices per delivery day, with the reason for every fetch, and the full per-slot tariff breakdown (Elektrilevi packages, winter peaks, holidays, night window).
  - Price forecasts (eupowerprices.com or nordpool-predict-fi) and the Solcast PV forecast.
  - Every value the MPC uses, with where it came from and how old it is.
- **Runs:** every job with its inputs, the payload sent, an Explain table, EMHASS's response and its log lines. Any run can be downloaded as one file.
- **Modes:**
  - **Off:** shadow builds every quarter-hour.
  - **Dry run:** all checks, nothing sent.
  - **Live:** sends to EMHASS, verifies the plan, then publishes at each slot start and fires `emhass_lens_plan_published`.
- **Take over / Hand back:** switches the HACS integration's Auto MPC and EMHASS Lens together, in one step.
- **Parity:** compares prices, PV and payloads with the HACS integration every quarter-hour.
- **Health:** EMHASS discovery, configuration checks, problems with history, and Home Assistant notifications.
- **ML:** fit, tune and predict on demand.
- **MQTT entities:** import/export price now, problem, last MPC, an Auto MPC switch and a Run MPC button.
- **Inverter control (experimental, off by default):** decides each slot like the "EMHASS: Consolidated Inverter Control" automation, and in dry run compares with what the automation did.

## 0.1.0

- First build: App packaging, settings with change history, scheduler, run records, live logs.
