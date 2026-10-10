"""The Plan page's history: for each past slot what the plan said at the time and what was measured,
with error statistics per quantity and for the price forecast."""

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

from emhass_lens.api.schemas import (
    AccuracyWindow,
    ActualValues,
    HistorySlot,
    MeasurementQuantity,
    MeasurementStatus,
    PlanHistoryResponse,
    PlannedValues,
    PlanPrice,
    PriceForecastAccuracy,
    QuantityAccuracy,
)
from emhass_lens.core.clock import iso, parse_iso
from emhass_lens.core.slots import SLOT, slot_floor
from emhass_lens.domain.accuracy import Accuracy, accuracy, pick_snapshot, sign_hint
from emhass_lens.services.prices import area_tz

if TYPE_CHECKING:
    from emhass_lens.container import Container

WINDOWS_H = (24, 168)
PRICE_LEAD = timedelta(hours=24)
# quantity, plan_row column, unit, MAPE makes sense, factor applied to both sides before comparing
QUANTITIES: tuple[tuple[str, str, str, bool, float], ...] = (
    ("load", "p_load", "W", True, 1.0),
    ("pv", "p_pv", "W", False, 1.0),
    ("soc", "soc", "%", False, 100.0),
    ("grid", "p_grid", "W", False, 1.0),
    ("batt", "p_batt", "W", False, 1.0),
)


def _out(quantity: str, unit: str, acc: Accuracy, suspect: bool) -> QuantityAccuracy:
    return QuantityAccuracy(
        quantity=quantity,
        unit=unit,
        n=acc.n,
        coverage=round(acc.coverage, 3),
        mae=acc.mae,
        bias=acc.bias,
        rmse=acc.rmse,
        mape=acc.mape,
        sign_suspect=suspect,
    )


class PlanHistoryService:
    def __init__(self, c: Container) -> None:
        self.c = c

    async def history(self, hours: int, horizon: int) -> PlanHistoryResponse:
        c = self.c
        x = c.extras
        now = c.clock.now()
        end = slot_floor(now)
        span_h = max(hours, *WINDOWS_H)
        start_all = end - timedelta(hours=span_h)
        slots = [start_all + i * SLOT for i in range(span_h * 4)]
        lead = horizon * SLOT

        emhass = x["emhass"]
        snapshots = await c.app_db.run(emhass.snapshots_between, start_all - lead - timedelta(days=2), now)
        generated = dict(snapshots)
        pick = pick_snapshot(snapshots, slots, lead)
        wanted = [(sid, iso(slot) or "") for slot, sid in pick.items() if sid is not None]
        rows = await c.app_db.run(emhass.plan_rows_for, wanted)
        measured = await c.app_db.run(x["measurements"].read, start_all, end)

        def planned_row(slot: datetime) -> dict[str, Any] | None:
            sid = pick.get(slot)
            return rows.get((sid, iso(slot) or "")) if sid is not None else None

        def actual(slot: datetime, quantity: str) -> float | None:
            hit = measured.get(quantity, {}).get(iso(slot) or "")
            return hit[0] if hit else None

        def pairs(
            window: list[datetime], column: str, quantity: str, factor: float
        ) -> list[tuple[float | None, float | None]]:
            out: list[tuple[float | None, float | None]] = []
            for slot in window:
                row = planned_row(slot)
                p = row.get(column) if row else None
                a = actual(slot, quantity)
                out.append((p * factor if p is not None else None, a * factor if a is not None else None))
            return out

        windows: list[AccuracyWindow] = []
        for window_h in WINDOWS_H:
            window = slots[-window_h * 4 :]
            quantities: list[QuantityAccuracy] = []
            for quantity, column, unit, use_mape, factor in QUANTITIES:
                pp = pairs(window, column, quantity, factor)
                acc = accuracy(pp, mape=use_mape, mape_floor=100.0)
                suspect = quantity in ("grid", "batt") and sign_hint(pp)
                quantities.append(_out(quantity, unit, acc, suspect))
            windows.append(AccuracyWindow(hours=window_h, horizon=horizon, quantities=quantities))

        shown = slots[-hours * 4 :]
        out_slots: list[HistorySlot] = []
        for slot in shown:
            row = planned_row(slot) or {}
            sid = pick.get(slot)
            out_slots.append(
                HistorySlot(
                    start=iso(slot) or "",
                    planned=PlannedValues(
                        P_grid=row.get("p_grid"),
                        P_batt=row.get("p_batt"),
                        P_PV=row.get("p_pv"),
                        P_Load=row.get("p_load"),
                        P_deferrable=row.get("p_deferrable"),
                        SOC=row.get("soc"),
                    ),
                    planned_at=iso(generated[sid]) if sid is not None and sid in generated else None,
                    actual=ActualValues(
                        grid=actual(slot, "grid"),
                        batt=actual(slot, "batt"),
                        pv=actual(slot, "pv"),
                        load=actual(slot, "load"),
                        soc=actual(slot, "soc"),
                    ),
                )
            )

        window_start = shown[0] if shown else end
        forecast = x["forecasts"].current()
        priced = await c.app_db.run(x["prices"].priced, window_start, forecast)
        prices = [
            PlanPrice(
                start=iso(p.start) or "", import_price=p.import_price, export_price=p.export_price, origin=p.origin
            )
            for p in priced
            if p.start < end
        ]

        price_forecast = await self._price_forecast(slots[-WINDOWS_H[-1] * 4 :], end)
        status = await c.app_db.run(x["measurements"].status)
        return PlanHistoryResponse(
            timezone=str(area_tz(c.settings.current)),
            now=iso(now) or "",
            hours=hours,
            horizon=horizon,
            slots=out_slots,
            prices=prices,
            accuracy=windows,
            price_forecast=price_forecast,
            measurements=MeasurementStatus(
                configured=[MeasurementQuantity(**q) for q in status["configured"]],
                backfill_remaining_slots=status["backfill_remaining_slots"],
                last_sample_at=status["last_sample_at"],
                last_error=status["last_error"],
            ),
        )

    async def _price_forecast(self, slots: list[datetime], end: datetime) -> PriceForecastAccuracy | None:
        """The price forecast (as fetched 24 h before each slot) against Nord Pool's price, in c/kWh."""
        c = self.c
        provider = c.settings.current.forecast.source
        if provider == "none" or not slots:
            return None
        start = slots[0]

        def load() -> tuple[list[tuple[int, datetime]], dict[tuple[int, str], float], dict[str, float]]:
            snaps: list[tuple[int, datetime]] = []
            for r in c.app_db.query(
                "SELECT id, fetched_at FROM forecast_snapshot "
                "WHERE provider = ? AND fetched_at >= ? AND fetched_at <= ?",
                (provider, iso(start - PRICE_LEAD - timedelta(days=2)), iso(end)),
            ):
                stamp = parse_iso(r["fetched_at"])
                if stamp is not None:
                    snaps.append((int(r["id"]), stamp))
            points: dict[tuple[int, str], float] = {}
            if snaps:
                marks = ",".join("?" * len(snaps))
                for r in c.app_db.query(
                    f"SELECT snapshot_id, start_utc, end_utc, eur_mwh FROM forecast_point "
                    f"WHERE snapshot_id IN ({marks}) AND end_utc > ? AND start_utc < ?",
                    (*[s[0] for s in snaps], iso(start), iso(end)),
                ):
                    a, b = parse_iso(r["start_utc"]), parse_iso(r["end_utc"])
                    if a is None or b is None:
                        continue
                    t = a
                    while t < b:  # hourly points cover four slots
                        points[(int(r["snapshot_id"]), iso(t) or "")] = float(r["eur_mwh"])
                        t += SLOT
            actual = {iso(e.start) or "": e.eur_mwh for e in c.extras["prices"].entries(start, end)}
            return snaps, points, actual

        snaps, points, actual = await c.app_db.run(load)
        if not snaps:
            return None
        pick = pick_snapshot(snaps, slots, PRICE_LEAD)
        pairs: list[tuple[float | None, float | None]] = []
        for slot in slots:
            sid = pick.get(slot)
            key = iso(slot) or ""
            forecast = points.get((sid, key)) if sid is not None else None
            spot = actual.get(key)
            pairs.append((forecast / 10 if forecast is not None else None, spot / 10 if spot is not None else None))
        acc = accuracy(pairs, mape=True, mape_floor=1.0)
        return PriceForecastAccuracy(
            provider=provider,
            lead_hours=int(PRICE_LEAD.total_seconds() // 3600),
            n=acc.n,
            mae=acc.mae,
            bias=acc.bias,
            mape=acc.mape,
        )
