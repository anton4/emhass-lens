"""Choosing and comparing EMHASS cost functions (services/costfun.py, the costfun runtime parameter)."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from emhass_lens.core.clock import FakeClock
from tests.test_phase1 import make_client, prime, run_job
from tests.test_phase2 import live_client
from tests.world import TZ, World

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
LEGACY_SWITCH = "switch.nordpool_ee_prices_emhass_auto_mpc"


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    return w


def mpc_actions(world: World) -> list[dict]:
    return [payload for name, payload in world.emhass_actions if name == "naive-mpc-optim"]


def test_compare_runs_the_other_two_then_the_live_method(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        run = run_job(client, "emhass.costfun_compare")
        assert run["outcome"] == "ok", run
        assert run["summary"].startswith("Net cost over "), run["summary"]
        assert (
            "Profit (in use)" in run["summary"] and "Cost " in run["summary"] and "Self-consumption " in run["summary"]
        )
        sent = mpc_actions(world)
        assert [p.get("costfun") for p in sent] == ["cost", "self-consumption", None]  # the live one sends nothing
        assert sent[0]["load_cost_forecast"] == sent[2]["load_cost_forecast"]  # same inputs for all three
        assert {a["kind"] for a in run["artifacts"]} >= {
            "costfun:cost",
            "costfun:self-consumption",
            "request",
            "response",
        }
        # EMHASS ended with the live plan, and the App stored it as this run's plan
        assert "cost_fun_profit" in (world.emhass_plan["plan"] or [{}])[0]
        plan = client.get("/api/plan").json()
        assert plan["current"]["run_id"] == run["id"]

        body = client.get("/api/plan/costfun").json()
        assert body["available"] is True
        assert body["live_costfun"] == "profit" and body["live_source"] == "emhass_config"
        assert body["can_run"] is True and body["auto"] is False
        assert body["run_id"] == run["id"]
        results = {r["costfun"]: r for r in body["results"]}
        assert set(results) == {"profit", "cost", "self-consumption"}
        assert results["profit"]["live"] is True and results["cost"]["live"] is False
        for r in results.values():
            assert r["problem"] is None, r
            assert r["totals"]["slots"] == len(r["rows"]) > 0
            assert r["totals"]["net_cost_eur"] is not None
        assert results["cost"]["totals"]["emhass_objective_column"] == "cost_fun_cost"
        assert results["profit"]["totals"]["emhass_objective_column"] == "cost_fun_profit"
        # the methods differ in what the battery does, so the totals differ
        assert results["cost"]["totals"]["export_kwh"] != results["profit"]["totals"]["export_kwh"]
        assert len(body["history"]) == 1
        assert set(body["history"][0]["net_cost_eur"]) == {"profit", "cost", "self-consumption"}
    finally:
        client.__exit__(None, None, None)


def test_an_emhass_that_ignores_costfun_is_detected_and_reported(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    world.emhass_ignores_costfun = True
    client = live_client(tmp_path, world, clock)
    try:
        run = run_job(client, "emhass.costfun_compare")
        assert run["outcome"] == "ok", run  # the live plan still happened
        assert "Cost: no plan" in run["summary"]
        assert [p.get("costfun") for p in mpc_actions(world)] == ["cost", None]  # gave up after the first miss
        body = client.get("/api/plan/costfun").json()
        cost = next(r for r in body["results"] if r["costfun"] == "cost")
        assert "ignores the costfun runtime parameter" in cost["problem"]
        run_job(client, "health.evaluate")
        keys = {p["key"] for p in client.get("/api/problems").json()["active"]}
        assert "emhass.costfun_ignored" in keys
    finally:
        client.__exit__(None, None, None)


def test_the_chosen_cost_function_is_sent_with_every_live_run_and_verified(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(
        tmp_path,
        world,
        clock,
        emhass={"base_url": "http://emhass.test:5000", "mode": "live", "mpc": {"auto": True, "costfun": "cost"}},
    )
    try:
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "ok", run
        assert mpc_actions(world)[-1]["costfun"] == "cost"
        assert "cost_fun_cost" in world.emhass_plan["plan"][0]
        assert "EMHASS used" not in run["summary"]
        body = client.get("/api/plan/costfun").json()
        assert body["live_costfun"] == "cost" and body["live_source"] == "settings"

        world.emhass_ignores_costfun = True
        clock.set(datetime(2026, 10, 9, 11, 28, 0, tzinfo=UTC))  # the next quarter: a new plan with a new timestamp
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "ok"
        assert run["summary"].endswith("; EMHASS used profit, not cost"), run["summary"]
        run_job(client, "health.evaluate")
        keys = {p["key"] for p in client.get("/api/problems").json()["active"]}
        assert "emhass.costfun_ignored" in keys
    finally:
        client.__exit__(None, None, None)


def test_compare_on_every_run_happens_inside_the_mpc_job(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(
        tmp_path,
        world,
        clock,
        emhass={"base_url": "http://emhass.test:5000", "mode": "live", "mpc": {"auto": True, "compare_costfuns": True}},
    )
    try:
        run = run_job(client, "emhass.mpc")
        assert run["outcome"] == "ok", run
        assert [p.get("costfun") for p in mpc_actions(world)] == ["cost", "self-consumption", None]
        assert run["summary"].startswith("Net cost over ")
        assert "Planned " in run["summary"]
        body = client.get("/api/plan/costfun").json()
        assert body["auto"] is True and body["run_id"] == run["id"]
        assert len(body["results"]) == 3
    finally:
        client.__exit__(None, None, None)


def test_compare_is_refused_when_emhass_must_not_be_called(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    with make_client(tmp_path, world, clock) as client:  # safe mode: EMHASS mode Off
        prime(client, world)
        run = run_job(client, "emhass.costfun_compare")
        assert run["outcome"] == "refused"
        assert "the mode is Off" in (run.get("error") or "") + (run.get("summary") or "")
        body = client.get("/api/plan/costfun").json()
        assert body["available"] is False and body["can_run"] is False
        assert "Off" in body["cannot_run_reason"]
        assert mpc_actions(world) == []
