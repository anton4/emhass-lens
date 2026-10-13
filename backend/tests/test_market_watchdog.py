"""The market session watchdog: the pure checks, and the job that clears a stale session in Live, records what it
would do in Shadow and reports a long session or the EMHASS switch left off, once each."""

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

from emhass_lens.core.clock import FakeClock
from emhass_lens.domain.market_watchdog import WatchdogInputs, check
from emhass_lens.settings.model import MarketWatchdog, Settings
from tests.test_market_service import (
    APPLY,
    ENABLE,
    GRID,
    MODE,
    POWER,
    QW_ENABLE,
    SESSION,
    SOURCE,
    START,
    STATE,
    calls,
    client_for,
    container,
    manual_run,
    newest_id,
    presses,
    push,
    wait_for_run,
)
from tests.test_market_service import world as market_world  # noqa: F401  (fixture)
from tests.test_phase1 import prime, run_job, ticks
from tests.world import World

NOW = datetime(2026, 10, 9, 12, 0, tzinfo=UTC)
W = MarketWatchdog()
SOURCES = ["fusebox", "kratt"]
QUIET = WatchdogInputs(
    app_session=None,
    app_session_since=None,
    select="none",
    select_changed=NOW - timedelta(hours=1),
    source="kratt",
    source_changed=NOW - timedelta(hours=1),
    enable="on",
    enable_changed=NOW - timedelta(hours=1),
    passive_state="Self-use battery or PV",
)


def kinds(i: WatchdogInputs, shadow: bool = False, now: datetime = NOW) -> list[str]:
    return [f.kind for f in check(i, W, SOURCES, now, shadow=shadow)]


# --- the pure checks ----------------------------------------------------------------------------------------------
def test_nothing_to_report_when_quiet_or_while_a_market_names_the_source() -> None:
    assert kinds(QUIET) == []
    selling = replace(QUIET, select="sell", select_changed=NOW - timedelta(minutes=30))
    assert kinds(selling) == []
    assert kinds(replace(selling, source="fusebox", source_changed=NOW - timedelta(hours=2))) == []


def test_a_session_goes_stale_after_the_source_is_gone_for_stale_after_s() -> None:
    session = replace(QUIET, select="buy", select_changed=NOW - timedelta(minutes=30), source="unavailable")
    assert kinds(replace(session, source_changed=NOW - timedelta(seconds=599))) == []
    [finding] = check(replace(session, source_changed=NOW - timedelta(seconds=601)), W, SOURCES, NOW, shadow=False)
    assert finding.kind == "stale" and finding.severity == "error" and finding.direction == "buy"
    assert finding.message == 'buy session: qw_source has been "unavailable" for 10 min'
    assert (
        check(replace(session, source_changed=NOW - timedelta(seconds=601)), W, SOURCES, NOW, shadow=True)[0].severity
        == "warning"
    )
    assert kinds(replace(session, source="none", source_changed=NOW - timedelta(minutes=11))) == ["stale"]
    # another list of known sources is respected
    custom = check(
        replace(session, source="elering", source_changed=NOW - timedelta(minutes=11)),
        W,
        ["elering"],
        NOW,
        shadow=False,
    )
    assert custom == []


def test_a_missing_source_counts_from_the_session_start() -> None:
    session = replace(QUIET, select="sell", source=None, source_changed=None)
    assert kinds(replace(session, select_changed=NOW - timedelta(minutes=5))) == []
    [finding] = check(replace(session, select_changed=NOW - timedelta(minutes=11)), W, SOURCES, NOW, shadow=False)
    assert finding.kind == "stale" and "qw_source has been missing for 11 min" in finding.message


def test_the_apps_own_session_wins_over_the_select() -> None:
    app = replace(
        QUIET,
        app_session="sell",
        app_session_since=NOW - timedelta(hours=4),
        select="none",
        source="unavailable",
        source_changed=NOW - timedelta(minutes=20),
    )
    found = check(app, W, SOURCES, NOW, shadow=False)
    assert [f.kind for f in found] == ["stale", "long_session"]
    assert {f.direction for f in found} == {"sell"}
    assert found[1].since == NOW - timedelta(hours=4)


def test_a_long_session_from_either_start() -> None:
    by_select = replace(QUIET, select="sell", select_changed=NOW - timedelta(hours=3))
    [finding] = check(by_select, W, SOURCES, NOW, shadow=False)
    assert finding.kind == "long_session" and finding.severity == "warning"
    assert finding.message == "sell session from kratt has been open for 3.0 h"
    assert kinds(replace(by_select, select_changed=NOW - timedelta(hours=2, minutes=59))) == []
    by_app = replace(QUIET, app_session="buy", app_session_since=NOW - timedelta(hours=3, minutes=6))
    assert kinds(by_app) == ["long_session"]


def test_emhass_off_needs_no_session_a_forced_state_and_the_switch_off_long_enough() -> None:
    off = replace(QUIET, enable="off", enable_changed=NOW - timedelta(minutes=10), passive_state="Force charge")
    [finding] = check(off, W, SOURCES, NOW, shadow=False)
    assert finding.kind == "emhass_off" and finding.severity == "error" and finding.direction is None
    assert (
        finding.message == 'the inverter is in "Force charge" with EMHASS off for 10 min, but no market session is open'
    )
    assert kinds(replace(off, passive_state="Force discharge")) == ["emhass_off"]
    assert kinds(replace(off, enable_changed=NOW - timedelta(minutes=9))) == []
    assert kinds(replace(off, passive_state="Self-use battery or PV")) == []
    assert kinds(replace(off, enable="on")) == []
    assert kinds(replace(off, select="buy", select_changed=NOW - timedelta(minutes=1))) == []  # a session: expected
    assert kinds(replace(off, enable_changed=None)) == []  # unknown: don't guess


def test_episodes_stay_the_same_while_the_situation_lasts() -> None:
    stale = replace(
        QUIET,
        select="sell",
        select_changed=NOW - timedelta(minutes=30),
        source="unavailable",
        source_changed=NOW - timedelta(minutes=11),
    )
    first = check(stale, W, SOURCES, NOW, shadow=False)[0]
    later = check(stale, W, SOURCES, NOW + timedelta(minutes=5), shadow=False)[0]
    assert first.episode == later.episode and later.age_s > first.age_s
    other = check(replace(stale, source_changed=NOW - timedelta(minutes=12)), W, SOURCES, NOW, shadow=False)[0]
    assert other.episode != first.episode
    assert first.as_dict()["since"] == "2026-10-09T11:49:00.000+00:00"


def test_the_settings_get_the_watchdog_defaults() -> None:
    w = Settings.model_validate({"market": {"mode": "live"}}).market.watchdog
    assert (w.enabled, w.stale_after_s, w.long_session_s, w.emhass_off_s) == (True, 600, 10800, 600)


# --- the job ------------------------------------------------------------------------------------------------------
def notifies(world: World, since: int = 0) -> list[dict]:
    return [s[1] for s in world.ha_services[since:] if s[0] == "notify/mobile_app_test"]


def device_calls(world: World, since: int = 0) -> list[tuple[str, str | None]]:
    return [c for c in calls(world, since) if c[0].startswith(("number", "button", "input_"))]


def problems(client) -> dict[str, dict]:
    run_job(client, "health.evaluate")
    return {p["key"]: p for p in client.get("/api/problems").json()["active"]}


def start_selling(client, world: World) -> None:
    before = newest_id(client, "market.reconcile")
    push(client, world, POWER, 5000)
    push(client, world, MODE, "mfrrup")
    started = wait_for_run(client, "market.reconcile", before)
    assert started["outcome"] == "ok", started
    wait_for_run(client, "market.reconcile", started["id"] - 1)  # let the queued rerun finish too


def test_live_clears_a_stale_session_the_controller_is_blocked_from_ending(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        start_selling(client, world)
        assert world.ha_states[SESSION]["state"] == "sell" and world.ha_states[ENABLE]["state"] == "off"
        # the controller is switched off mid-session and the source goes away: nothing would end the session
        world.set_state(QW_ENABLE, "off")
        clock.advance(minutes=12)
        world.set_state(SOURCE, "unavailable", updated=clock.now() - timedelta(minutes=11))
        prime(client, world)
        blocked = manual_run(client, "market.reconcile")
        assert blocked["outcome"] == "noop" and blocked["summary"].startswith("Not in control"), blocked

        n = len(world.ha_services)
        cleared = manual_run(client, "market.watchdog")
        assert cleared["outcome"] == "ok", cleared
        assert cleared["summary"].startswith(
            'Watchdog: cleared a stale sell session: qw_source has been "unavailable" for 11 min.'
        )
        assert cleared["summary"].endswith("No fresh plan to hand back to: set the safe state.")
        assert device_calls(world, n)[:2] == [
            ("input_select/select_option", SESSION),
            ("input_boolean/turn_on", ENABLE),
        ]
        assert presses(world, APPLY, n) == 1
        assert world.ha_states[GRID]["state"] == "0.0" and world.ha_states[STATE]["state"] == "Self-use battery or PV"
        assert world.ha_states[SESSION]["state"] == "none" and world.ha_states[ENABLE]["state"] == "on"
        [message] = notifies(world, n)
        assert message["title"] == "Qilowatt watchdog"
        assert message["message"].startswith(
            'Qilowatt watchdog: cleared a stale sell session: qw_source has been "unavailable"'
        )
        assert "Inverter reset to self-use, EMHASS re-enabled." in message["message"]
        [session] = client.get("/api/market/sessions").json()
        assert session["end_reason"] == "watchdog" and session["ended_at"]
        status = client.get("/api/market").json()
        assert status["session"] is None
        assert status["watchdog"]["last_action"]["run_id"] == cleared["id"] and status["watchdog"]["findings"] == []
        kinds_ = {a["kind"] for a in cleared["artifacts"]}
        assert {"watchdog", "notifications", "handback_calls", "calls"} <= kinds_

        m = len(world.ha_services)
        again = manual_run(client, "market.watchdog")
        assert again["outcome"] == "noop" and len(world.ha_services) == m
    finally:
        client.__exit__(None, None, None)


def test_live_clears_a_session_only_the_select_knows_and_skips_registers_already_safe(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    world.set_state(SESSION, "buy", updated=START - timedelta(minutes=30))
    world.set_state(ENABLE, "off", updated=START - timedelta(minutes=30))
    world.set_state(STATE, "Force charge")
    world.set_state(SOURCE, "unknown", updated=START - timedelta(minutes=15))
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        n = len(world.ha_services)
        cleared = manual_run(client, "market.watchdog")
        assert cleared["outcome"] == "ok", cleared
        assert cleared["summary"].endswith(
            "No fresh plan to hand back to: set the state select; the registers were already safe."
        )
        assert presses(world, APPLY, n) == 0  # grid 0 and the rails were right: no EEPROM write
        assert world.ha_states[STATE]["state"] == "Self-use battery or PV"
        assert world.ha_states[SESSION]["state"] == "none" and world.ha_states[ENABLE]["state"] == "on"
        [message] = notifies(world, n)
        assert "Registers were already clean, no EEPROM write" in message["message"]
        assert client.get("/api/market/sessions").json() == []  # the App never had this session
    finally:
        client.__exit__(None, None, None)


def test_shadow_records_what_it_would_clear_and_writes_nothing(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    world.set_state(SESSION, "sell", updated=START - timedelta(minutes=20))
    world.set_state(SOURCE, "unavailable", updated=START - timedelta(minutes=11))
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "shadow")
    try:
        n = len(world.ha_services)
        would = manual_run(client, "market.watchdog")
        assert would["outcome"] == "dry_run", would
        assert would["summary"] == 'Would clear a stale sell session: qw_source has been "unavailable" for 11 min'
        assert device_calls(world, n) == [] and notifies(world, n) == []
        found = problems(client)["market.watchdog.stale"]
        assert found["severity"] == "warning" and found["title"] == "A market session looks stuck"
        assert "market.watchdog.off" not in problems(client)
        again = manual_run(client, "market.watchdog")
        assert again["outcome"] == "noop" and again["summary"].startswith("Already reported")
    finally:
        client.__exit__(None, None, None)


def test_a_long_session_is_reported_once(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    world.set_state(SESSION, "sell", updated=START - timedelta(hours=3, minutes=1))
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        n = len(world.ha_services)
        reported = manual_run(client, "market.watchdog")
        assert reported["outcome"] == "ok", reported
        assert reported["summary"] == "Reported: sell session from kratt has been open for 3.0 h"
        [message] = notifies(world, n)
        assert message["message"].endswith("Not intervening, just make sure this is expected.")
        assert device_calls(world, n) == []
        assert problems(client)["market.watchdog.long_session"]["severity"] == "warning"
        m = len(world.ha_services)
        assert manual_run(client, "market.watchdog")["outcome"] == "noop"
        assert notifies(world, m) == []
    finally:
        client.__exit__(None, None, None)


def test_the_emhass_switch_left_off_is_reported_once_per_episode(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    world.set_state(STATE, "Force discharge")
    world.set_state(ENABLE, "off", updated=START - timedelta(minutes=5))
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        n = len(world.ha_services)
        early = manual_run(client, "market.watchdog")
        assert early["outcome"] == "noop" and notifies(world, n) == []
        world.set_state(ENABLE, "off", updated=START - timedelta(minutes=11))
        prime(client, world)
        reported = manual_run(client, "market.watchdog")
        assert reported["outcome"] == "ok" and reported["summary"].startswith(
            'Reported: the inverter is in "Force discharge"'
        )
        [message] = notifies(world, n)
        assert message["message"].endswith("Someone needs to check this.")
        assert problems(client)["market.watchdog.emhass_off"]["severity"] == "error"
        assert manual_run(client, "market.watchdog")["outcome"] == "noop"
        assert len(notifies(world, n)) == 1
        world.set_state(ENABLE, "off", updated=START - timedelta(minutes=12))  # switched again: a new episode
        prime(client, world)
        assert manual_run(client, "market.watchdog")["outcome"] == "ok"
        assert len(notifies(world, n)) == 2
    finally:
        client.__exit__(None, None, None)


def test_the_minute_probe_records_nothing_until_something_is_due(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        job = next(j for j in client.get("/api/jobs").json() if j["id"] == "market.watchdog")
        assert job["next_run"] == "2026-10-09T11:13:40.000+00:00"
        clock.set(datetime(2026, 10, 9, 11, 13, 40, tzinfo=UTC))
        for _ in ticks():
            if client.get("/api/market").json()["watchdog"]["checked_at"] == "2026-10-09T11:13:40.000+00:00":
                break
        assert client.get("/api/runs", params={"job": "market.watchdog"}).json() == []

        world.set_state(SESSION, "sell", updated=START - timedelta(minutes=20))
        world.set_state(SOURCE, "none", updated=START - timedelta(minutes=11))
        prime(client, world)
        clock.set(datetime(2026, 10, 9, 11, 14, 40, tzinfo=UTC))
        promoted = wait_for_run(client, "market.watchdog", 0, trigger="event")
        assert promoted["outcome"] == "ok" and promoted["summary"].startswith("Watchdog: cleared a stale sell session")
        assert world.ha_states[SESSION]["state"] == "none"
    finally:
        client.__exit__(None, None, None)


def test_off_disabled_or_disconnected_does_nothing(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    world.set_state(SESSION, "sell", updated=START - timedelta(minutes=20))
    world.set_state(SOURCE, "none", updated=START - timedelta(minutes=11))
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live", watchdog={"enabled": False})
    try:
        n = len(world.ha_services)
        off = manual_run(client, "market.watchdog")
        assert off["outcome"] == "noop" and off["summary"].startswith("The session watchdog is off")
        assert device_calls(world, n) == []
        assert client.get("/api/market").json()["watchdog"]["mode"] == "off"
        warned = problems(client)["market.watchdog.off"]
        assert "turned off" in warned["detail"]
        rev = client.get("/api/settings").json()["revision"]
        changes = {"market": {"watchdog": {"enabled": True}}}
        assert client.patch("/api/settings", json={"base_revision": rev, "changes": changes}).status_code == 200
        container(client).extras["ha"].connected = False
        refused = manual_run(client, "market.watchdog")
        assert refused["outcome"] == "refused" and "Not connected" in refused["summary"]
        assert device_calls(world, n) == []
    finally:
        client.__exit__(None, None, None)


def test_a_market_run_in_progress_goes_first_and_the_watchdog_rechecks(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    world.set_state(SESSION, "sell", updated=START - timedelta(minutes=20))
    world.set_state(SOURCE, "none", updated=START - timedelta(minutes=11))
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        portal = client.portal
        assert portal is not None
        lock = container(client).extras["market"].act_lock
        portal.call(lock.acquire)
        run_id = client.post("/api/jobs/market.watchdog/run").json()["run_id"]
        assert client.get(f"/api/runs/{run_id}").json()["outcome"] == "running"
        world.set_state(SESSION, "none")  # the controller ended it meanwhile
        n = len(world.ha_services)
        portal.call(lock.release)
        run: dict = {}
        for _ in ticks():
            run = client.get(f"/api/runs/{run_id}").json()
            if run["outcome"] != "running":
                break
        assert run["outcome"] == "noop", run
        assert device_calls(world, n) == []
    finally:
        client.__exit__(None, None, None)


def test_two_concurrent_session_ends_close_it_once(
    tmp_path: Path,
    market_world: World,  # noqa: F811
) -> None:
    world = market_world
    clock = FakeClock(START)
    client = client_for(tmp_path, world, clock, "live")
    try:
        start_selling(client, world)
        market = container(client).extras["market"]
        portal = client.portal
        assert portal is not None

        async def both() -> None:
            await asyncio.gather(
                market._close_session("first", None, clock.now()), market._close_session("second", None, clock.now())
            )

        portal.call(both)
        [session] = client.get("/api/market/sessions").json()
        assert market.session is None and session["end_reason"] == "first"
    finally:
        client.__exit__(None, None, None)
