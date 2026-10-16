"""The market rules must match the HA automation 'Qilowatt: Master Market Controller' guard for guard, except for the
feed-in limit during a sell, which EMHASS Lens writes far less often, and a gap only the proportional deadband hides,
which EMHASS Lens writes once it holds for the cooldown (the automation's calls are kept as parity_*)."""

from datetime import UTC, datetime, timedelta

from emhass_lens.domain.market import (
    CommandSpan,
    Expected,
    MarketInputs,
    command_spans,
    compare_expected,
    decide,
    expected_after,
)
from emhass_lens.settings.model import InverterLimits, MarketThresholds
from tests.fixtures.loader import load_json

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


def test_fusebox_sell_follows_the_command_and_the_automations_feedin_targets() -> None:
    plain = decide(inp(source="fusebox", mode="mfrrup", powerlimit_w=5000), T, L)
    assert plain.targets.grid_power_w == -5000 and plain.parity_feedin_w == 15500  # type: ignore[union-attr]
    assert decide(sell(pv_power_w=3000), T, L).parity_feedin_w == 5000
    assert decide(sell(pv_power_w=50), T, L).parity_feedin_w == 15500


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


def test_a_gap_the_deadband_hides_is_written_once_it_holds_for_the_cooldown() -> None:
    """2026-10-14 (runs 5631-5646): Kratt raised a sell from 9400 W to 10600 W. 1200 W is inside 15 % of 10600 W, so
    the automation's rule held -9400 W for the ten minutes left of the command."""
    morning = {"session": "sell", "cur_grid_w": -9400, "mode": "frrup", "powerlimit_w": 10600, "since_commit_s": 200}
    for fresh in (None, 22):
        d = decide(inp(**morning, gap_for_s=fresh), T, L)
        assert d.needs_update is False and d.parity_needs_update is False and d.throttle.gap_held is False
        assert d.throttle.effective_deadband_w == 1590
        assert any("written at 180 s if it stays" in r for r in d.throttle.reasons)
    held = decide(inp(**morning, gap_for_s=202), T, L)
    assert held.needs_update is True and held.throttle.gap_held is True and held.throttle.effective_deadband_w == 300
    assert held.targets is not None and held.targets.grid_power_w == -10600
    assert "gap held 202 s ≥ 180 s: deadband 300 W" in held.throttle.reasons
    assert held.parity_needs_update is False  # the automation would still hold it ...
    assert expected_after(held, inp(**morning, gap_for_s=202)).grid_power_w == -9400  # ... and shadow judges that
    # a gap within deadband_w is never written, and the cooldown still holds a held gap
    assert decide(inp(**{**morning, "powerlimit_w": 9600}, gap_for_s=999), T, L).needs_update is False
    cooling = decide(inp(**{**morning, "since_commit_s": 60}, gap_for_s=202), T, L)
    assert cooling.needs_update is False and cooling.throttle.cooldown_block is True
    # beyond the proportional deadband both write at once, held or not
    big = decide(inp(**{**morning, "powerlimit_w": 12000}), T, L)
    assert big.needs_update and big.parity_needs_update and big.throttle.gap_held is False


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


def test_the_automation_writes_feedin_only_while_selling() -> None:
    assert decide(sell(cur_feedin_w=0, since_feedin_commit_s=5), T, L).parity_feedin_write is True  # initial
    assert decide(sell(cur_feedin_w=15500), T, L).parity_feedin_write is False
    cooled = decide(
        sell(session="sell", cur_grid_w=-5000, pv_power_w=3000, cur_feedin_w=15500, since_feedin_commit_s=60), T, L
    )
    assert cooled.parity_feedin_write is False
    due = decide(
        sell(session="sell", cur_grid_w=-5000, pv_power_w=3000, cur_feedin_w=15500, since_feedin_commit_s=200), T, L
    )
    assert due.parity_feedin_write is True and due.parity_feedin_w == 5000
    low_pv = decide(sell(session="sell", cur_grid_w=-5000, pv_power_w=50, cur_feedin_w=0), T, L)
    assert low_pv.parity_feedin_write is False
    assert decide(inp(mode="mfrrdown", powerlimit_w=5000, cur_feedin_w=0), T, L).feedin_write is False


# --- EMHASS Lens's own feed-in rule during a sell (the session of 2026-10-13, Kratt frrup, SOC 92-93 %) -----------


def selling(**kw) -> MarketInputs:
    return sell(**{"session": "sell", "soc_pct": 93.0, "cur_grid_w": -1800, "since_commit_s": 999, **kw})


def test_a_sell_keeps_a_feedin_limit_that_lets_the_command_out() -> None:
    # run 4368: 1800 W commanded, PV 1600 W, house ~550 W: the automation writes 1800 W, the limit at 15500 W will do
    d = decide(selling(powerlimit_w=1800, pv_power_w=1600, load_w=550), T, L)
    assert (d.feedin_w, d.feedin_write) == (15500, False)
    assert (
        d.feedin_why == "kept 15500 W: at least the commanded 1800 W; the battery takes the spare PV (SOC 93 % < 97 %)"
    )
    assert (d.parity_feedin_w, d.parity_feedin_write) == (1800, True)
    # around run 4429: the battery covers part of the house, nothing to spare
    none = decide(selling(powerlimit_w=5900, pv_power_w=2400, load_w=2500, cur_feedin_w=5900), T, L)
    assert none.feedin_write is False and "no PV to spare (PV 2400 W, house 2500 W)" in none.feedin_why


def test_a_feedin_limit_below_the_command_is_raised_to_the_sell_cap_at_once() -> None:
    # run 4396: 4200 W commanded with the limit at 2600 W, 25 s after the last feed-in write: the automation waited
    # for its cooldown and exported 2600 W for three minutes
    d = decide(
        selling(powerlimit_w=4200, pv_power_w=1700, load_w=600, cur_feedin_w=2600, since_feedin_commit_s=25), T, L
    )
    assert (d.feedin_w, d.feedin_write) == (15500, True)
    assert d.feedin_why.startswith("raised to the sell cap 15500 W: 2600 W is below the commanded 4200 W")
    assert d.parity_feedin_write is False
    unknown = decide(selling(cur_feedin_w=None), T, L)
    assert (unknown.feedin_w, unknown.feedin_write) == (15500, True) and "unknown is below" in unknown.feedin_why


def test_the_feedin_limit_is_never_lowered_while_the_battery_can_take_the_spare_pv() -> None:
    # the battery still took 620-900 W at 93 % (2026-10-13 06:09-06:14): below 97 % nothing is lowered, even in sun
    sunny = decide(selling(powerlimit_w=2000, pv_power_w=6000, load_w=1000, cur_feedin_w=15500), T, L)
    assert (sunny.feedin_w, sunny.feedin_write) == (15500, False)
    assert "the battery takes the spare PV (SOC 93 % < 97 %)" in sunny.feedin_why
    # run 4408: 1000 W commanded, PV 1700 W, house ~680 W, the limit at 2600 W: kept
    kept = decide(selling(powerlimit_w=1000, pv_power_w=1700, load_w=680, cur_feedin_w=2600), T, L)
    assert (kept.feedin_w, kept.feedin_write) == (2600, False)
    room = decide(selling(powerlimit_w=1000, pv_power_w=6000, load_w=200, soc_pct=85.0), T, L)
    assert room.feedin_write is False and "the battery takes the spare PV (SOC 85 % < 97 %)" in room.feedin_why


def test_the_feedin_limit_follows_the_command_only_with_a_full_battery_and_pv_to_spare() -> None:
    def full(**kw) -> MarketInputs:
        return selling(**{"soc_pct": 98.0, "powerlimit_w": 1000, "pv_power_w": 1700, **kw})

    # 1020 W to spare is within the command and the deadband: kept
    assert decide(full(load_w=680, cur_feedin_w=2600), T, L).feedin_write is False
    # with the house at 200 W, 1500 W to spare could go out on top of the command
    capped = decide(full(load_w=200, cur_feedin_w=2600, since_feedin_commit_s=204), T, L)
    assert (capped.feedin_w, capped.feedin_write) == (1000, True)
    assert capped.feedin_why.startswith("lowered to the commanded 1000 W: SOC 98 % ≥ 97 %")
    waiting = decide(full(load_w=200, cur_feedin_w=2600, since_feedin_commit_s=60), T, L)
    assert (waiting.feedin_w, waiting.feedin_write) == (2600, False) and "cooldown (60 s < 180 s)" in waiting.feedin_why
    near = decide(full(load_w=200, cur_feedin_w=1200), T, L)
    assert (near.feedin_w, near.feedin_write) == (1200, False) and "within 300 W above" in near.feedin_why
    # a cap below a rising command is raised at once, cooldown or not: to the command while PV is to spare ...
    rising = decide(
        full(powerlimit_w=1500, pv_power_w=3000, load_w=200, cur_feedin_w=1000, since_feedin_commit_s=10), T, L
    )
    assert (rising.feedin_w, rising.feedin_write) == (1500, True) and rising.feedin_why.startswith("capped at")
    # ... and to the sell cap once it isn't (like run 4412: 5900 W commanded right after a 1000 W limit)
    up = decide(full(powerlimit_w=5900, pv_power_w=1800, load_w=200, cur_feedin_w=1000, since_feedin_commit_s=30), T, L)
    assert (up.feedin_w, up.feedin_write) == (15500, True)
    # an unknown house load counts all PV as spare; a session start lowers it without waiting
    blind = decide(full(), T, L)
    assert (blind.feedin_w, blind.feedin_write) == (1000, True) and "house load unknown" in blind.feedin_why
    start = decide(sell(soc_pct=98.0, powerlimit_w=1000, pv_power_w=1700, since_feedin_commit_s=5), T, L)
    assert (start.feedin_w, start.feedin_write) == (1000, True)
    # the threshold is a setting
    lower = MarketThresholds(sell_full_soc_pct=90)
    assert decide(selling(powerlimit_w=1000, pv_power_w=1700, load_w=200, cur_feedin_w=2600), lower, L).feedin_write


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
    selling_now = sell(pv_power_w=3000)
    assert expected_after(decide(selling_now, T, L), selling_now).feedin_max_w is None  # deliberately not judged
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


def at(hh: int, mm: int, ss: float = 0) -> datetime:
    return datetime(2026, 10, 14, hh, mm, int(ss), round((ss % 1) * 1_000_000), tzinfo=UTC)


def test_command_spans_from_the_recorder_history() -> None:
    source, mode, power = load_json("ha", "qw_history.json")
    spans = command_spans(source, mode, power, T, at(5, 0), at(7, 30))
    assert spans == [
        # Kratt's sell at 08:45 local: 9420 W is commanded as 9400 W, then 7000 W until the mode clears
        CommandSpan(at(5, 45, 12.345), at(5, 55), "sell", "kratt", "mfrrup", 9400, open=False),
        CommandSpan(at(5, 55), at(6, 4, 30), "sell", "kratt", "mfrrup", 7000, open=False),
        # a buy, cut while the source is unavailable, and still on at the end of the window
        CommandSpan(at(6, 58), at(7, 0), "buy", "kratt", "mfrrdown", 5000, open=False),
        CommandSpan(at(7, 1, 30), at(7, 30), "buy", "kratt", "mfrrdown", 5000, open=True),
    ]


def test_command_spans_start_with_the_state_in_force() -> None:
    source, mode, power = load_json("ha", "qw_history.json")
    # the window opens mid-sell: the span starts with the window
    spans = command_spans(source, mode, power, T, at(5, 50), at(6, 0))
    assert [(s.start, s.end, s.power_w, s.open) for s in spans] == [
        (at(5, 50), at(5, 55), 9400, False),
        (at(5, 55), at(6, 0), 7000, True),
    ]
    assert command_spans(source, mode, power, T, at(4, 0), at(5, 0)) == []
    assert command_spans([], [], [], T, at(4, 0), at(5, 0)) == []
    # a source the thresholds don't know isn't a command
    unknown = MarketThresholds(sources=["fusebox"])
    assert command_spans(source, mode, power, unknown, at(5, 0), at(7, 30)) == []


def test_back_to_back_commands_of_one_direction_share_their_session_start() -> None:
    from emhass_lens.domain.market import CommandSpan, session_starts

    t = datetime(2026, 10, 9, 8, 0, tzinfo=UTC)

    def span(a: int, b: int, direction: str = "sell") -> CommandSpan:
        return CommandSpan(
            t + timedelta(seconds=a), t + timedelta(seconds=b), direction, "kratt", "mfrrup", 9000, False
        )

    spans = [span(60, 120), span(0, 60), span(120, 130, "buy"), span(400, 500)]
    assert session_starts(spans) == [t, t, t + timedelta(seconds=120), t + timedelta(seconds=400)]
    assert session_starts([]) == []
