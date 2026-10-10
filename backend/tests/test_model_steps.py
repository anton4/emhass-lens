"""A tuned EMHASS load model forecasts fewer slots than the horizon: learn it, cut the horizon, plan again at once.
Also: a busy EMHASS is not unreachable."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from emhass_lens.clients.emhass import body_lines
from emhass_lens.core.clock import FakeClock
from emhass_lens.core.slots import slot_floor
from emhass_lens.domain.mpc.anchor import anchor_slot
from emhass_lens.domain.mpc.model_steps import short_model
from emhass_lens.domain.mpc.payload import build
from emhass_lens.settings.model import Settings
from tests.test_mpc import inputs_at, utc
from tests.test_phase1 import run_job, ticks
from tests.test_phase2 import LEGACY_SWITCH, live_client
from tests.world import TZ, World, short_model_log

START = datetime(2026, 10, 9, 11, 13, 0, tzinfo=UTC)
EMHASS = "http://emhass.test:5000"


@pytest.fixture
def world() -> World:
    w = World()
    w.standard_entities(datetime(2026, 10, 9, tzinfo=TZ))
    w.set_state(LEGACY_SWITCH, "off")
    return w


def sent(world: World) -> list[dict]:
    return [payload for name, payload in world.emhass_actions if name == "naive-mpc-optim"]


def next_run(client: TestClient, job: str, after_id: int) -> dict:
    for _ in ticks():
        runs = [r for r in client.get("/api/runs", params={"job": job}).json() if r["id"] > after_id]
        if runs and all(r["outcome"] != "running" for r in runs):
            return runs[-1]
    raise AssertionError(f"no {job} run after #{after_id}")


def problem_keys(client: TestClient) -> set[str]:
    run_job(client, "health.evaluate")
    return {p["key"] for p in client.get("/api/problems").json()["active"]}


# --- pure parts ---------------------------------------------------------------------------------------------------


def test_the_short_model_is_read_from_emhass_s_answer() -> None:
    body = json.dumps(short_model_log(144, 233))
    assert short_model(body) == (144, 233)
    assert short_model("ERROR - solver failed") is None
    assert short_model(json.dumps(short_model_log(300, 233))) is None  # enough steps: something else failed
    lines = body_lines(body)
    assert len(lines) == len(short_model_log(144, 233))
    assert [line for line in lines if "ERROR" in line][-1].startswith("ERROR - emhass.web_server - Unable to obtain")
    assert body_lines("a\nb") == ["a", "b"]
    assert body_lines('["not", 1]') == ['["not", 1]']


def test_the_horizon_is_cut_to_the_model_but_never_in_the_compat_build() -> None:
    now = utc(2026, 10, 9, 11, 13, 0)
    inputs = inputs_at(now)
    anchor = anchor_slot(now, "nearest")
    full = build(inputs, anchor, slot_floor(now), Settings())
    assert full.horizon > 50
    cut = build(inputs, anchor, slot_floor(now), Settings(), model_steps=50)
    assert cut.horizon == cut.payload["prediction_horizon"] == len(cut.payload["pv_power_forecast"]) == 50
    assert len(cut.explain) == 50 and cut.payload["load_cost_forecast"] == full.payload["load_cost_forecast"][:50]
    [issue] = [i for i in cut.issues if i.code == "horizon_capped"]
    assert issue.level == "warning" and "only 50 slots" in issue.message
    assert build(inputs, anchor, slot_floor(now), Settings(), model_steps=50, compat=True).horizon == full.horizon
    roomy = build(inputs, anchor, slot_floor(now), Settings(), model_steps=full.horizon + 10)
    assert roomy.horizon == full.horizon and not [i for i in roomy.issues if i.code == "horizon_capped"]


# --- the live path ------------------------------------------------------------------------------------------------


def test_a_short_model_fails_one_run_then_plans_the_cut_horizon_until_a_fit(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    world.emhass_model_steps = 40
    client = live_client(tmp_path, world, clock)
    try:
        first = run_job(client, "emhass.mpc")
        wanted = sent(world)[0]["prediction_horizon"]
        assert wanted > 40
        assert first["outcome"] == "error"
        assert first["summary"] == (
            f"EMHASS's load model covers only 40 of {wanted} slots (a tuned model forecasts as far as the lag count "
            "it picked); planning again with 40 slots"
        )
        response = client.get(f"/api/runs/{first['id']}/artifacts/response").json()
        assert response["error"].startswith("HTTP 400: ERROR - emhass.web_server - Unable to obtain: ")
        assert "Setting input data dict" not in response["error"]  # one line, not EMHASS's whole log

        again = next_run(client, "emhass.mpc", first["id"])
        assert again["outcome"] == "ok", again
        assert again["summary"].startswith("Planned ")
        assert sent(world)[-1]["prediction_horizon"] == 40
        validation = client.get(f"/api/runs/{again['id']}/artifacts/validation").json()
        assert [v for v in validation if v["code"] == "horizon_capped"]
        assert "ml.model_short" in problem_keys(client)

        later = run_job(client, "emhass.mpc")  # the next quarter: cut straight away, no failed run
        assert later["outcome"] == "ok" and sent(world)[-1]["prediction_horizon"] == 40

        assert run_job(client, "ml.fit")["outcome"] == "ok"
        assert "ml.model_short" not in problem_keys(client)
        full = run_job(client, "emhass.mpc")
        assert full["outcome"] == "ok" and sent(world)[-1]["prediction_horizon"] == wanted
    finally:
        client.__exit__(None, None, None)


def test_the_cut_is_forgotten_after_a_day_so_an_outside_refit_is_noticed(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        ml = client.app.state.container.extras["ml"]  # type: ignore[attr-defined]
        client.portal.call(ml.learn_steps, 40, 150)  # type: ignore[union-attr]
        assert ml.model_steps(clock.now()) == 40
        assert ml.model_steps(clock.now() + timedelta(hours=23)) == 40
        assert ml.model_steps(clock.now() + timedelta(hours=25)) is None
        assert ml.short_info(clock.now() + timedelta(hours=25)) is None
    finally:
        client.__exit__(None, None, None)


def test_a_comparison_that_meets_a_short_model_stops_and_the_replan_succeeds(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    world.emhass_model_steps = 40
    client = live_client(
        tmp_path,
        world,
        clock,
        emhass={"base_url": EMHASS, "mode": "live", "mpc": {"auto": True, "compare_costfuns": True}},
    )
    try:
        first = run_job(client, "emhass.mpc")
        assert first["outcome"] == "error" and "planning again with 40 slots" in first["summary"]
        again = next_run(client, "emhass.mpc", first["id"])
        assert again["outcome"] == "ok", again
        wanted = sent(world)[0]["prediction_horizon"]
        # the comparison stopped at its first request; the re-plan ran two alternatives, then the live method
        assert [p["prediction_horizon"] for p in sent(world)] == [wanted, 40, 40, 40]
    finally:
        client.__exit__(None, None, None)


# --- busy is not unreachable --------------------------------------------------------------------------------------


def test_a_health_timeout_while_emhass_computes_our_action_is_not_unreachable(tmp_path: Path, world: World) -> None:
    clock = FakeClock(START)
    client = live_client(tmp_path, world, clock)
    try:
        emhass = client.app.state.container.extras["emhass"]  # type: ignore[attr-defined]
        assert emhass.reachable is True
        world.emhass_health_timeout = True
        emhass.busy = ("forecast-model-tune", clock.now())
        run_job(client, "emhass.health")
        assert emhass.reachable is True
        status = client.get("/api/emhass").json()
        assert status["busy_with"] == "forecast-model-tune" and status["busy_since"] is not None
        lines = [e["msg"] for e in client.app.state.container.logging.ring.tail()]  # type: ignore[attr-defined]
        assert any(line.startswith("EMHASS is busy with forecast-model-tune (since ") for line in lines)

        emhass.busy = None  # nothing of ours runs: a timeout means EMHASS doesn't answer
        run_job(client, "emhass.health")
        assert emhass.reachable is False

        world.emhass_health_timeout = False
        run_job(client, "emhass.health")
        assert emhass.reachable is True
        world.emhass_up = False  # a refused connection is a crash or restart, busy or not
        emhass.busy = ("naive-mpc-optim", clock.now())
        run_job(client, "emhass.health")
        assert emhass.reachable is False
    finally:
        client.__exit__(None, None, None)
