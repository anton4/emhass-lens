from typing import Any

from emhass_lens.domain.entity_search import search_entities


def state(entity_id: str, name: str | None = None) -> dict[str, Any]:
    return {"entity_id": entity_id, "state": "1", "attributes": {"friendly_name": name} if name else {}}


STATES = [
    state("sensor.house_battery_soc_estimate", "House battery SOC estimate"),
    state("sensor.ev6_battery_soc", "EV6 Battery SOC"),
    state("sensor.soc", "SOC"),
    state("input_number.emhass_target_soc", "EMHASS target SOC"),
    state("sensor.grid_power", "Grid power"),
    state("switch.associated_lamp", "Hall lamp"),
]


def ids(found: list[dict[str, Any]]) -> list[str]:
    return [s["entity_id"] for s in found]


def test_empty_search_lists_the_domains_alphabetically() -> None:
    found = search_entities(STATES, {"sensor"}, "", 10)
    assert ids(found) == [
        "sensor.ev6_battery_soc",
        "sensor.grid_power",
        "sensor.house_battery_soc_estimate",
        "sensor.soc",
    ]


def test_best_matches_come_first() -> None:
    # exact id, then the id starting with the text, then a word starting with it, then any other match
    found = search_entities(STATES, None, "sensor.soc", 10)
    assert ids(found) == ["sensor.soc"]
    found = search_entities(STATES, None, "soc", 10)
    assert ids(found)[0] == "sensor.soc"
    assert set(ids(found)) == {
        "sensor.soc",
        "sensor.ev6_battery_soc",
        "sensor.house_battery_soc_estimate",
        "input_number.emhass_target_soc",
        "switch.associated_lamp",  # "soc" inside "associated": found, but last
    }
    assert ids(found)[-1] == "switch.associated_lamp"


def test_every_word_must_match_the_id_or_the_name() -> None:
    found = search_entities(STATES, None, "ev6 SOC", 10)
    assert ids(found) == ["sensor.ev6_battery_soc"]
    found = search_entities(STATES, None, "hall", 10)  # only in the friendly name
    assert ids(found) == ["switch.associated_lamp"]


def test_domains_and_limit() -> None:
    found = search_entities(STATES, {"sensor", "input_number"}, "soc", 2)
    assert ids(found) == ["sensor.soc", "input_number.emhass_target_soc"]  # equal rank: by entity id
    assert search_entities([{"entity_id": "broken"}, {}], None, "", 10) == []
