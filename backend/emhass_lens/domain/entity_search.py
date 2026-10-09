"""Entity search for the settings pickers: which Home Assistant states match what was typed, best first."""

import re
from collections.abc import Iterable
from typing import Any

_WORD_SPLIT = re.compile(r"[\s._\-]+")


def search_entities(
    states: Iterable[dict[str, Any]], domains: set[str] | None, q: str, limit: int
) -> list[dict[str, Any]]:
    """States in `domains` whose entity id or friendly name contains every word of `q`.

    Best first: the exact id, then ids that start with the text (with or without the domain), then
    entities where a word starts with the first search word, then any other match. Ties go by entity id.
    """
    text = q.strip().lower()
    terms = text.split()
    ranked: list[tuple[int, str, dict[str, Any]]] = []
    for state in states:
        entity_id = str(state.get("entity_id") or "")
        domain, _, object_id = entity_id.partition(".")
        if not object_id or (domains and domain not in domains):
            continue
        name = str((state.get("attributes") or {}).get("friendly_name") or "").lower()
        haystack = f"{entity_id} {name}"
        if any(term not in haystack for term in terms):
            continue
        ranked.append((_rank(entity_id, object_id, name, text, terms), entity_id, state))
    ranked.sort(key=lambda item: (item[0], item[1]))
    return [state for _, _, state in ranked[:limit]]


def _rank(entity_id: str, object_id: str, name: str, text: str, terms: list[str]) -> int:
    if not terms:
        return 0
    if entity_id == text:
        return 0
    if entity_id.startswith(text) or object_id.startswith(text):
        return 1
    words = _WORD_SPLIT.split(f"{entity_id} {name}")
    if any(word.startswith(terms[0]) for word in words):
        return 2
    return 3
