"""One writer for the Sofar passive-mode registers, shared by the plan-driven inverter control and the market
controller.

Every press of the apply button writes registers that persist to EEPROM (a wear event), so this is the one place
that reads what the registers show, works out the minimal calls, presses the buttons, reads back, and remembers when
each register group was last committed (in memory and in app.db, so a cooldown survives a restart). It also logs
every press of the two buttons that Home Assistant reports, ours or anyone's, so the wear is visible.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.domain.inverter import Observed, Targets, compare_targets
from emhass_lens.runs.recorder import RunRefused
from emhass_lens.scheduler.core import JobContext
from emhass_lens.services.ha_values import num, text

if TYPE_CHECKING:
    from emhass_lens.container import Container

log = logging.getLogger("emhass_lens.sofar")

Call = dict[str, Any]  # {"service": "number.set_value", "entity_id": ..., "value": ...} or {"option": ...}
GROUPS = ("passive", "feedin")


@dataclass(frozen=True)
class Registers:
    """What the inverter entities show."""

    state: str | None  # input_select.emhass_passive_state
    grid_power_w: float | None
    battery_max_w: float | None
    battery_min_w: float | None
    feedin_max_w: float | None
    charger_mode: str | None  # select.sofar_charger_use_mode
    emhass_enabled: str | None  # input_boolean.emhass_automation
    apply_pressed_at: datetime | None  # the apply button's state is the time of its last press
    feedin_pressed_at: datetime | None

    def observed(self) -> Observed:
        return Observed(self.state, self.grid_power_w, self.battery_max_w, self.battery_min_w, self.feedin_max_w)


@dataclass
class CommitResult:
    calls: list[Call]
    readback: dict[str, Any]
    wrote_passive: bool
    wrote_feedin: bool
    ok: bool
    error: str | None


class SofarWriter:
    def __init__(self, c: Container) -> None:
        self.c = c
        self.lock = asyncio.Lock()  # one commit at a time, whoever owns the decision
        self.last_commit: dict[str, datetime] = {}
        self._press_seen: dict[str, str] = {}

    def load(self) -> None:
        rows = self.c.app_db.query("SELECT register_group, MAX(at) AS at FROM sofar_commit GROUP BY register_group")
        for row in rows:
            stamp = parse_iso(row["at"])
            if stamp is not None:
                self.last_commit[row["register_group"]] = stamp

    # --- reading ----------------------------------------------------------------------------------------------------
    def _e(self):
        return self.c.settings.current.inverter.entities

    def entities(self) -> set[str]:
        e = self._e()
        return {
            e.charger_mode_select,
            e.enable_boolean,
            e.state_select,
            e.grid_power_number,
            e.battery_max_number,
            e.battery_min_number,
            e.apply_button,
            e.feedin_number,
            e.feedin_button,
        } - {""}

    def _state(self, entity_id: str) -> dict[str, Any] | None:
        return self.c.extras["ha"].state(entity_id) if entity_id else None

    def registers(self) -> Registers:
        e = self._e()
        return Registers(
            state=text(self._state(e.state_select)),
            grid_power_w=num(self._state(e.grid_power_number)),
            battery_max_w=num(self._state(e.battery_max_number)),
            battery_min_w=num(self._state(e.battery_min_number)),
            feedin_max_w=num(self._state(e.feedin_number)),
            charger_mode=text(self._state(e.charger_mode_select)),
            emhass_enabled=text(self._state(e.enable_boolean)),
            apply_pressed_at=_pressed_at(self._state(e.apply_button)),
            feedin_pressed_at=_pressed_at(self._state(e.feedin_button)),
        )

    def observed(self) -> Observed:
        return self.registers().observed()

    async def refresh(self) -> None:
        """The WebSocket cache can lag (e.g. during a reconnect): re-read the inverter entities over REST."""
        ha = self.c.extras["ha"]
        for entity_id in sorted(self.entities()):
            state = await ha.get_state(entity_id)
            if state is None:
                ha.states.pop(entity_id, None)
            else:
                ha.states[entity_id] = state

    def last_commit_age_s(self, group: str, now: datetime) -> float | None:
        """Seconds since this register group was last written: our own commit, or the button's own timestamp
        (anyone's press), whichever is more recent. None when neither is known."""
        regs = self.registers()
        pressed = regs.apply_pressed_at if group == "passive" else regs.feedin_pressed_at
        stamps = [t for t in (self.last_commit.get(group), pressed) if t is not None]
        return (now - max(stamps)).total_seconds() if stamps else None

    # --- writing -----
    def check_limits(self, targets: Targets | None, feedin_w: int | None) -> None:
        limits = self.c.settings.current.inverter.limits
        if targets is not None:
            if not (limits.battery_min_w <= targets.battery_min_w <= targets.battery_max_w <= limits.battery_max_w):
                raise RunRefused(
                    f"Battery limits {targets.battery_min_w}…{targets.battery_max_w} W are outside the configured range"
                )
            if not (-limits.export_max_w <= targets.grid_power_w <= limits.grid_import_max_w):
                raise RunRefused(f"Grid target {targets.grid_power_w} W is outside the configured range")
        if feedin_w is not None and not (0 <= feedin_w <= limits.export_max_w):
            raise RunRefused(f"Feed-in limit {feedin_w} W is outside 0…{limits.export_max_w} W")

    def plan_calls(
        self, before: Registers, targets: Targets | None, feedin_w: int | None
    ) -> tuple[list[Call], list[Call]]:
        """The calls that change something: (passive group, feed-in group). Each group is written whole, because
        the apply button commits all three numbers; the state select rides along without a press."""
        e = self._e()
        passive: list[Call] = []
        if targets is not None:
            if e.state_select and before.state != targets.state:
                passive.append(
                    {"service": "input_select.select_option", "entity_id": e.state_select, "option": targets.state}
                )
            if (before.grid_power_w, before.battery_max_w, before.battery_min_w) != (
                float(targets.grid_power_w),
                float(targets.battery_max_w),
                float(targets.battery_min_w),
            ):
                passive += [
                    {"service": "number.set_value", "entity_id": e.grid_power_number, "value": targets.grid_power_w},
                    {"service": "number.set_value", "entity_id": e.battery_max_number, "value": targets.battery_max_w},
                    {"service": "number.set_value", "entity_id": e.battery_min_number, "value": targets.battery_min_w},
                    {"service": "button.press", "entity_id": e.apply_button},
                ]
        feedin: list[Call] = []
        if feedin_w is not None and (before.feedin_max_w is None or abs(before.feedin_max_w - feedin_w) >= 0.5):
            feedin = [
                {"service": "number.set_value", "entity_id": e.feedin_number, "value": feedin_w},
                {"service": "button.press", "entity_id": e.feedin_button},
            ]
        return passive, feedin

    async def commit(
        self,
        ctx: JobContext,
        *,
        owner: str,
        targets: Targets | None,
        feedin_w: int | None,
        feedin_first: bool = False,
        feedin_settle_s: float = 0.0,
        before_calls: list[Call] | None = None,
    ) -> CommitResult:
        """Write what differs (targets=None or feedin_w=None leaves that group alone), press the buttons, read back.
        `before_calls` go first (e.g. a session select and the enable switch)."""
        assert ctx.run is not None
        ha = self.c.extras["ha"]
        async with self.lock:
            before = self.registers()
            passive, feedin = self.plan_calls(before, targets, feedin_w)
            groups = (
                [("feedin", feedin), ("passive", passive)]
                if feedin_first
                else [("passive", passive), ("feedin", feedin)]
            )
            done: list[Call] = []
            failed_groups: set[str] = set()
            for call in before_calls or []:
                done.append(await self.call(ha, call))
            for index, (group, calls) in enumerate(groups):
                if not calls:
                    continue
                if index == 1 and feedin_settle_s > 0 and groups[0][1]:
                    await self.c.clock.wait(asyncio.Event(), feedin_settle_s)  # the inverter digests the feed-in first
                for call in calls:
                    result = await self.call(ha, call)
                    done.append(result)
                    if not result["ok"]:
                        failed_groups.add(group)
                if group not in failed_groups:
                    await self._log_commit(owner, group, targets, feedin_w, ctx.run.id)
            ctx.run.artifact("calls", done)
            readback = await self._read_back(targets if passive or targets is not None else None, feedin_w)
            ctx.run.artifact("readback", readback)
        failed = [c for c in done if not c["ok"]]
        error = "; ".join(str(c.get("error", "")) for c in failed) if failed else None
        if not failed and not readback["agree"]:
            error = "the inverter doesn't show the targets"
        return CommitResult(done, readback, bool(passive), bool(feedin), error is None, error)

    async def call(self, ha: Any, call: Call) -> Call:
        """One Home Assistant service call from its dict form; never raises, the result says ok or not."""
        domain, service = str(call["service"]).split(".", 1)
        data = {k: v for k, v in call.items() if k != "service"}
        try:
            await ha.call_service(domain, service, data)
            return {**call, "ok": True}
        except Exception as exc:
            log.error("Inverter call %s failed: %s", call["service"], exc)
            return {**call, "ok": False, "error": str(exc)}

    async def _log_commit(
        self, owner: str, group: str, targets: Targets | None, feedin_w: int | None, run_id: int
    ) -> None:
        now = self.c.clock.now()
        self.last_commit[group] = now
        await self.c.app_db.aexecute(
            "INSERT INTO sofar_commit"
            " (at, owner, register_group, grid_w, battery_max_w, battery_min_w, feedin_w, run_id)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                iso(now),
                owner,
                group,
                targets.grid_power_w if targets else None,
                targets.battery_max_w if targets else None,
                targets.battery_min_w if targets else None,
                feedin_w,
                run_id,
            ),
        )

    async def _read_back(
        self, targets: Targets | None, feedin_w: int | None, attempts: int = 10, every_s: float = 0.5
    ) -> dict[str, Any]:
        """Re-read the inverter entities until they show the targets (or give up after ~5 s)."""
        result: dict[str, Any] = {"agree": True, "fields": []}
        for attempt in range(attempts):
            await self.refresh()
            result = compare_targets(targets, feedin_w, self.observed())
            if result["agree"] or attempt == attempts - 1:
                break
            await self.c.clock.wait(asyncio.Event(), every_s)
        return result

    # --- wear -----
    async def on_button_state(self, entity_id: str, state: dict[str, Any] | None) -> None:
        """Every change of a button's state is one press (its state is the time of the last press)."""
        stamp = str((state or {}).get("state") or "")
        if not stamp or stamp in ("unknown", "unavailable") or self._press_seen.get(entity_id) == stamp:
            self._press_seen[entity_id] = stamp
            return
        first = entity_id not in self._press_seen
        self._press_seen[entity_id] = stamp
        if first:
            return  # the state as first seen (startup, re-watch) isn't a new press
        await self.c.app_db.aexecute(
            "INSERT INTO sofar_press (at, entity_id) VALUES (?, ?)", (iso(self.c.clock.now()), entity_id)
        )

    async def wear(self, hours: int) -> dict[str, Any]:
        e = self._e()
        since = iso(self.c.clock.now() - timedelta(hours=hours))
        presses = await self.c.app_db.aquery(
            "SELECT entity_id, COUNT(*) AS n, MAX(at) AS last FROM sofar_press WHERE at >= ? GROUP BY entity_id",
            (since,),
        )
        commits = await self.c.app_db.aquery(
            "SELECT register_group, COUNT(*) AS n FROM sofar_commit WHERE at >= ? AND ok = 1 GROUP BY register_group",
            (since,),
        )
        by_entity = {r["entity_id"]: r for r in presses}
        by_group = {r["register_group"]: r["n"] for r in commits}
        apply_n = by_entity.get(e.apply_button, {}).get("n", 0)
        feedin_n = by_entity.get(e.feedin_button, {}).get("n", 0)
        return {
            "hours": hours,
            "apply_presses": apply_n,
            "feedin_presses": feedin_n,
            "our_commits": by_group.get("passive", 0) + by_group.get("feedin", 0),
            "presses_not_ours": max(0, apply_n - by_group.get("passive", 0))
            + max(0, feedin_n - by_group.get("feedin", 0)),
            "last_apply_at": by_entity.get(e.apply_button, {}).get("last"),
            "last_feedin_at": by_entity.get(e.feedin_button, {}).get("last"),
        }

    def prune(self, now: datetime) -> int:
        cut = iso(now - timedelta(days=self.c.settings.current.logging.retention.runs_days))
        n = self.c.app_db.execute("DELETE FROM sofar_press WHERE at < ?", (cut,)).rowcount
        n += self.c.app_db.execute("DELETE FROM sofar_commit WHERE at < ?", (cut,)).rowcount
        return n


def _pressed_at(state: dict[str, Any] | None) -> datetime | None:
    """A button entity's state is the ISO time of its last press."""
    value = (state or {}).get("state")
    if not value or value in ("unknown", "unavailable"):
        return None
    try:
        return parse_iso(str(value))
    except ValueError:
        return None
