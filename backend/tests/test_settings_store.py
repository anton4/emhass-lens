import pytest

from emhass_lens.core.redact import MASK, redactor
from emhass_lens.settings.model import Settings
from emhass_lens.settings.store import SettingsInvalid, SettingsStore, StaleRevision


async def test_defaults_are_stored_as_first_revision(store: SettingsStore) -> None:
    assert store.revision == 1
    assert store.current == Settings()
    [rev] = await store.revisions()
    assert rev["source"] == "default"


async def test_partial_save_creates_revision_with_diff(store: SettingsStore) -> None:
    result = await store.save(
        {"emhass": {"mode": "dry_run"}, "prices": {"tariff": {"vat_pct": 22}}},
        base_revision=1,
        actor="Jorma",
        comment="try dry run",
    )
    assert result.revision == 2
    assert {d["path"] for d in result.diff} == {"emhass.mode", "prices.tariff.vat_pct"}
    assert store.current.emhass.mode == "dry_run"
    [newest, _] = await store.revisions()
    assert newest["actor"] == "Jorma"
    assert newest["comment"] == "try dry run"


async def test_stale_base_revision_is_rejected(store: SettingsStore) -> None:
    await store.save({"emhass": {"mode": "dry_run"}}, base_revision=1, actor="a")
    with pytest.raises(StaleRevision) as exc:
        await store.save({"emhass": {"mode": "live"}}, base_revision=1, actor="b")
    assert exc.value.current == 2


async def test_invalid_settings_report_field_paths(store: SettingsStore) -> None:
    with pytest.raises(SettingsInvalid) as exc:
        await store.save({"prices": {"tariff": {"vat_pct": 250}}}, base_revision=1, actor="a")
    assert exc.value.errors[0]["loc"] == "prices.tariff.vat_pct"
    assert store.revision == 1


async def test_cross_field_rule_needs_api_key(store: SettingsStore) -> None:
    with pytest.raises(SettingsInvalid) as exc:
        await store.save({"forecast": {"source": "ee_eupowerprices"}}, base_revision=1, actor="a")
    assert "API key" in exc.value.errors[0]["msg"]


async def test_secrets_are_masked_and_kept_when_sent_back_masked(store: SettingsStore) -> None:
    await store.save(
        {"forecast": {"source": "ee_eupowerprices", "ee": {"api_key": "super-secret-key"}}},
        base_revision=1,
        actor="a",
    )
    masked = store.masked()
    assert masked["forecast"]["ee"]["api_key"] == MASK
    # the form sends everything back, including the mask: the key must survive
    result = await store.save(masked, base_revision=2, actor="a", partial=False)
    assert result.diff == []
    assert store.current.forecast.ee.api_key == "super-secret-key"
    assert redactor.text("key=super-secret-key") == f"key={MASK}"
    [newest, *_] = await store.revisions()
    assert all(MASK in (str(d["new"]), str(d["old"])) or d["path"] != "forecast.ee.api_key" for d in newest["diff"])


async def test_revert_creates_new_revision(store: SettingsStore) -> None:
    await store.save({"emhass": {"mode": "live"}}, base_revision=1, actor="a")
    result = await store.revert(1, base_revision=2, actor="a")
    assert result.revision == 3
    assert store.current.emhass.mode == "off"
    [newest, *_] = await store.revisions()
    assert newest["source"] == "revert"


async def test_subscribers_get_only_their_paths(store: SettingsStore) -> None:
    seen: list[list[str]] = []
    store.subscribe("logging", lambda old, new, paths: seen.append(paths))
    await store.save({"emhass": {"mode": "dry_run"}}, base_revision=1, actor="a")
    assert seen == []
    await store.save({"logging": {"level": "debug"}}, base_revision=2, actor="a")
    assert seen == [["logging.level"]]


def test_reload_reads_newest_revision(app_db, bus, clock) -> None:
    first = SettingsStore(db=app_db, bus=bus, clock=clock)
    first.load()
    app_db.execute(
        "INSERT INTO settings_revision (created_at, source, schema_version, doc_json, diff_json) "
        "VALUES ('x', 'ui', 1, ?, '[]')",
        (Settings(emhass={"mode": "live"}).model_dump_json(),),  # type: ignore[arg-type]
    )
    second = SettingsStore(db=app_db, bus=bus, clock=clock)
    second.load()
    assert second.revision == 2
    assert second.current.emhass.mode == "live"


def test_invalid_stored_settings_fall_back_to_defaults_with_errors(app_db, bus, clock) -> None:
    app_db.execute(
        "INSERT INTO settings_revision (created_at, source, schema_version, doc_json, diff_json) "
        "VALUES ('x', 'ui', 1, '{\"emhass\": {\"mode\": \"turbo\"}}', '[]')"
    )
    store = SettingsStore(db=app_db, bus=bus, clock=clock)
    store.load()
    assert store.load_errors and store.load_errors[0]["loc"] == "emhass.mode"
    assert store.current == Settings()
