"""The market rules must match the HA automation 'Qilowatt: Master Market Controller' guard for guard."""

from emhass_lens.domain.market import Expected, MarketInputs, compare_expected, decide, expected_after
from emhass_lens.settings.model import InverterLimits, MarketThresholds

T = MarketThresholds()
L = InverterLimits()


def inp(**kw) -> MarketInputs:
    base: dict = {
        "source": "kratt",
        "mode": "none",
        "powerlimit_w": 0.0,
        "source_lost_for_s": 0.0,
        "soc_pct": 50.0,
        "pv_power_w": 0.0,
        "session": None,
        "cur_grid_w": 0.0,
        "cur_battery_max_w": 20000.0,
        "cur_battery_min_w": -20000.0,
        "cur_feedin_w": 15500.0,
        "since_commit_s": None,
        "since_feedin_commit_s": None,
        "trigger_kind": "reconcile",
        "trigger_entity": "reconcile",
    }
    base.update(kw)
    return MarketInputs(**base)


def sell(**kw) -> MarketInputs:
    return inp(**{"mode": "mfrrup", "powerlimit_w": 5000, **kw})


def test_nothing_commanded_does_nothing() -> None:
    d = decide(inp(), T, L)
    assert d.action == "none" and d.needs_update is False and d.notify is None and d.targets is None


def test_a_sell_starts_a_session() -> None:
    d = decide(sell(cur_feedin_w=0), T, L)
    assert d.action == "sell" and d.targets is not None
    assert (d.targets.state, d.targets.grid_power_w, d.targets.battery_max_w, d.targets.battery_min_w) == (
        "Force discharge",
        -5000,
        20000,
        -20000,
    )
    assert d.feedin_w == 15500 and d.feedin_write is True  # PV below 100 W: the export maximum, written at the start
    assert d.needs_update is True and "session start" in d.throttle.bypass_reasons
    assert d.session_after == "sell" and d.enable_boolean_after == "off"
    assert d.message == "Kratt sell 5000W" and d.notify is None
    assert decide(sell(), T, L).feedin_write is False  # feed-in already right


def test_a_buy_and_the_grid_caps() -> None:
    d = decide(inp(mode="mfrrdown", powerlimit_w=5000), T, L)
    assert d.action == "buy" and d.targets is not None and d.targets.state == "Force charge"
    assert d.targets.grid_power_w == 5000 and d.feedin_w == 5000 and d.feedin_write is False
    assert d.session_after == "buy"
    assert decide(inp(source="fusebox", mode="frrdown", powerlimit_w=5000), T, L).targets.grid_power_w == 18200  # type: ignore[union-attr]
    assert decide(inp(mode="mfrrdown", powerlimit_w=20000), T, L).targets.grid_power_w == 18200  # type: ignore[union-attr]
    capped = decide(inp(mode="mfrrup", powerlimit_w=20000, pv_power_w=3000), T, L)
    assert capped.targets.grid_power_w == -15500 and capped.feedin_w == 15500  # type: ignore[union-attr]


def test_fusebox_sell_follows_the_command_and_feedin_targets() -> None:
    plain = decide(inp(source="fusebox", mode="mfrrup", powerlimit_w=5000), T, L)
    assert plain.targets.grid_power_w == -5000 and plain.feedin_w == 15500  # type: ignore[union-attr]
    assert decide(sell(pv_power_w=3000), T, L).feedin_w == 5000
    assert decide(sell(pv_power_w=50), T, L).feedin_w == 15500


def test_the_enter_gate_blocks_small_commands_and_a_small_flip_ends_the_session() -> None:
    assert decide(inp(mode="mfrrup", powerlimit_w=500), T, L).action == "none"
    d = decide(inp(session="sell", cur_grid_w=-2000, mode="frrdown", powerlimit_w=500), T, L)
    assert d.action == "end" and d.end_reason == "below_gate" and d.needs_update is True and d.anomaly is False


def test_continuing_uses_the_exit_gate_the_deadband_and_the_cooldown() -> None:
    going = decide(inp(session="sell", cur_grid_w=-1200, mode="mfrrup", powerlimit_w=2000, since_commit_s=200), T, L)
    assert going.action == "sell" and going.continuing and going.power_gate_w == 400
    assert going.throttle.grid_delta_w == 800 and going.throttle.effective_deadband_w == 300 and going.needs_update
    blocked = decide(inp(session="sell", cur_grid_w=-1200, mode="mfrrup", powerlimit_w=2000, since_commit_s=60), T, L)
    assert blocked.needs_update is False and blocked.throttle.cooldown_block is True
    assert any("60 s since the last write < 180 s" in r for r in blocked.throttle.reasons)
    inside = decide(inp(session="sell", cur_grid_w=-5000, mode="mfrrup", powerlimit_w=5200, since_commit_s=999), T, L)
    assert inside.needs_update is False and inside.throttle.effective_deadband_w == 780
    outside = decide(inp(session="sell", cur_grid_w=-5000, mode="mfrrup", powerlimit_w=6000, since_commit_s=999), T, L)
    assert outside.needs_update is True
    floor = decide(inp(session="sell", cur_grid_w=-1000, mode="mfrrup", powerlimit_w=1000, since_commit_s=999), T, L)
    assert floor.throttle.effective_deadband_w == 300


def test_the_cooldown_bypasses() -> None:
    start = decide(sell(since_commit_s=10), T, L)
    assert start.needs_update and "session start" in start.throttle.bypass_reasons
    flip = decide(inp(session="sell", cur_grid_w=-5000, mode="mfrrdown", powerlimit_w=3000, since_commit_s=10), T, L)
    assert flip.action == "buy" and flip.needs_update and "direction change" in flip.throttle.bypass_reasons
    assert flip.session_after == "buy" and flip.enable_boolean_after == "off"
    rails = decide(
        inp(
            session="sell",
            cur_grid_w=-5000,
            cur_battery_min_w=-3000,
            mode="mfrrup",
            powerlimit_w=5000,
            since_commit_s=10,
        ),
        T,
        L,
    )
    assert rails.needs_update and rails.throttle.rails_wrong and "battery rails wrong" in rails.throttle.bypass_reasons
    big = decide(inp(session="sell", cur_grid_w=-2000, mode="mfrrup", powerlimit_w=4600, since_commit_s=10), T, L)
    assert big.needs_update and big.throttle.grid_delta_w == 2600


def test_a_session_end_is_never_throttled() -> None:
    d = decide(inp(session="sell", cur_grid_w=-5000, since_commit_s=5), T, L)
    assert d.action == "end" and d.end_reason == "mode_cleared" and d.anomaly is False
    assert d.targets is not None and (d.targets.state, d.targets.grid_power_w) == ("Self-use battery or PV", 0)
    assert d.feedin_w == 0 and d.feedin_write is False  # computed, never written at an end
    assert d.needs_update is True and d.session_after is None and d.enable_boolean_after == "on"
    assert "Control returned to EMHASS" in d.message
    safe = decide(inp(session="sell", since_commit_s=5), T, L)
    assert safe.action == "end" and safe.needs_update is False


def test_low_soc_source_loss_and_bad_powerlimits() -> None:
    low = decide(sell(session="sell", cur_grid_w=-5000, soc_pct=9), T, L)
    assert low.action == "end" and low.end_reason == "low_soc" and low.anomaly and "low_soc" in (low.notify or "")
    assert decide(sell(soc_pct=9), T, L).action == "none"
    assert decide(inp(mode="mfrrdown", powerlimit_w=5000, soc_pct=5), T, L).action == "buy"
    kept = decide(inp(session="sell", source="unavailable", source_lost_for_s=100), T, L)
    assert kept.action == "none" and kept.session_after == "sell"
    lost = decide(inp(session="sell", source="unavailable", source_lost_for_s=400), T, L)
    assert lost.action == "end" and lost.end_reason == "source_lost" and lost.anomaly
    assert decide(inp(session="sell", source=None, source_lost_for_s=None), T, L).end_reason == "source_lost"
    cleared = decide(inp(session="buy", mode="none"), T, L)
    assert cleared.action == "end" and cleared.end_reason == "mode_cleared" and cleared.anomaly is False
    quiet = decide(inp(mode="mfrrup", powerlimit_w=0), T, L)
    assert quiet.action == "none" and quiet.bad_powerlimit and quiet.anomaly is False
    loud = decide(inp(mode="mfrrup", powerlimit_w=0, trigger_kind="qw", trigger_entity="sensor.qw_powerlimit"), T, L)
    assert loud.anomaly and loud.notify == "Qilowatt safeguard: ignored kratt mfrrup with powerlimit 0W."
    ended = decide(inp(session="sell", cur_grid_w=-5000, mode="mfrrup", powerlimit_w=0), T, L)
    assert ended.action == "end" and ended.end_reason == "below_gate" and ended.anomaly is False


def test_feedin_writes_only_while_selling() -> None:
    assert decide(sell(cur_feedin_w=0, since_feedin_commit_s=5), T, L).feedin_write is True  # initial: no cooldown
    assert decide(sell(cur_feedin_w=15500), T, L).feedin_write is False
    cooled = decide(
        sell(session="sell", cur_grid_w=-5000, pv_power_w=3000, cur_feedin_w=15500, since_feedin_commit_s=60), T, L
    )
    assert cooled.feedin_write is False
    due = decide(
        sell(session="sell", cur_grid_w=-5000, pv_power_w=3000, cur_feedin_w=15500, since_feedin_commit_s=200), T, L
    )
    assert due.feedin_write is True and due.feedin_w == 5000
    assert decide(sell(session="sell", cur_grid_w=-5000, pv_power_w=50, cur_feedin_w=0), T, L).feedin_write is False


def test_rounding_unknown_registers_sources_and_the_kill_switch() -> None:
    assert decide(sell(powerlimit_w=4850), T, L).qw_power_w == 4800  # 48.5 -> 48
    assert decide(sell(powerlimit_w=4950), T, L).qw_power_w == 5000
    assert decide(sell(powerlimit_w=4949), T, L).qw_power_w == 4900
    unknown = decide(sell(cur_grid_w=None, cur_battery_max_w=None, cur_battery_min_w=None), T, L)
    assert unknown.needs_update and unknown.throttle.rails_wrong
    assert decide(sell(source="Kratt"), T, L).action == "none"  # case-sensitive, like the Jinja `in`
    forced = decide(inp(session="sell", mode="mfrrup", powerlimit_w=5000, force_end=True), T, L)
    assert forced.action == "end" and forced.end_reason == "forced"
    assert decide(inp(force_end=True), T, L).action == "none"


def test_expected_after_and_compare() -> None:
    blocked = inp(session="sell", cur_grid_w=-1200, mode="mfrrup", powerlimit_w=2000, since_commit_s=60)
    e = expected_after(decide(blocked, T, L), blocked)
    assert e.session == "sell" and e.enable_boolean == "off" and e.grid_power_w == -1200
    ended = inp(session="sell", cur_grid_w=-5000, since_commit_s=5)
    e2 = expected_after(decide(ended, T, L), ended)
    assert (e2.session, e2.enable_boolean, e2.grid_power_w, e2.feedin_max_w) == ("none", "on", 0.0, 15500.0)
    observed = {
        "session": "none",
        "enable_boolean": "on",
        "state": "Self-use battery or PV",
        "grid_power_w": 0.4,
        "battery_max_w": 20000.0,
        "battery_min_w": -20000.0,
        "feedin_max_w": 15500.0,
    }
    assert compare_expected(e2, observed)["agree"] is True
    assert compare_expected(Expected("sell", None, None, None, None, None, None), {"session": "none"})["fields"] == [
        {"field": "session", "decided": "sell", "observed": "none", "same": False}
    ]
