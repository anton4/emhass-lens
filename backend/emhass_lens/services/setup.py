"""The getting-started checklist: how far the move from the HACS integration to EMHASS Lens is."""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from emhass_lens.container import Container


def step(
    key: str, title: str, state: str, detail: str, link: str | None = None, optional: bool = False
) -> dict[str, Any]:
    """state: done | todo | attention | skipped"""
    return {"key": key, "title": title, "state": state, "detail": detail, "link": link, "optional": optional}


async def checklist(c: Container) -> list[dict[str, Any]]:
    x = c.extras
    settings = c.settings.current
    steps: list[dict[str, Any]] = []
    ha, emhass, mpc = x["ha"], x["emhass"], x["mpc"]

    steps.append(
        step(
            "ha",
            "Connected to Home Assistant",
            "done" if ha.connected else "attention",
            f"Home Assistant {ha.ha_version}" if ha.connected else (ha.last_error or "connecting…"),
            "#/health",
        )
    )
    if emhass.reachable:
        steps.append(step("emhass", "EMHASS found", "done", f"EMHASS {emhass.version} at {emhass.url}", "#/health"))
    else:
        steps.append(
            step(
                "emhass",
                "EMHASS found",
                "attention",
                f"{emhass.last_error or 'not found yet'} — set the address under Settings → EMHASS",
                "#/settings?section=emhass",
            )
        )
    bad = [ch.title for ch in emhass.checks if ch.status == "error"]
    warn = [ch.title for ch in emhass.checks if ch.status == "warning"]
    if not emhass.checks:
        steps.append(step("emhass_config", "EMHASS configuration compatible", "todo", "not checked yet", "#/health"))
    else:
        steps.append(
            step(
                "emhass_config",
                "EMHASS configuration compatible",
                "attention" if bad else "done",
                ("Fix: " + ", ".join(bad)) if bad else ("OK" + (f" (warnings: {', '.join(warn)})" if warn else "")),
                "#/health",
            )
        )

    imported = await c.app_db.aquery_one(
        "SELECT id, created_at FROM settings_revision WHERE source = 'legacy_import' ORDER BY id DESC LIMIT 1"
    )
    legacy_present = ha.state(settings.parity.legacy_auto_mpc_switch) is not None if ha.connected else None
    if imported:
        steps.append(
            step(
                "import",
                "Settings imported from the HACS integration",
                "done",
                f"revision {imported['id']}",
                "#/settings",
            )
        )
    elif legacy_present is False:
        steps.append(
            step(
                "import",
                "Settings imported from the HACS integration",
                "skipped",
                "The HACS integration isn't installed; enter tariffs under Settings → Prices",
                "#/settings",
            )
        )
    else:
        steps.append(
            step(
                "import",
                "Settings imported from the HACS integration",
                "todo",
                "Health → Import from the HACS integration",
                "#/health",
            )
        )

    problems = [p for p in x["problems"].problems.values() if p.key.startswith("prices.")]
    steps.append(
        step(
            "prices",
            "Prices complete",
            "attention" if problems else "done",
            "; ".join(p.title for p in problems) or "today and tomorrow (once published)",
            "#/inputs",
        )
    )

    snapshot = x["inputs"].snapshot(c.clock.now()) if ha.connected else None
    if snapshot is None:
        steps.append(step("inputs", "Battery and EV inputs readable", "todo", "waiting for Home Assistant", "#/inputs"))
    else:
        unreadable = [r.name for r in (snapshot.soc_init, snapshot.soc_final) if r.value is None]
        steps.append(
            step(
                "inputs",
                "Battery and EV inputs readable",
                "attention" if unreadable else "done",
                ("Can't read: " + ", ".join(unreadable))
                if unreadable
                else f"SOC {snapshot.soc_init.value:.0%} now, target {snapshot.soc_final.value:.0%}",
                "#/settings?section=inputs" if unreadable else "#/inputs",
            )
        )

    parity = await c.recorder.list(job="parity.check", limit=8)
    compared = [r for r in parity if r["outcome"] in ("ok", "mismatch")]
    if legacy_present is False and not compared:
        steps.append(
            step(
                "parity",
                "Same prices and payloads as the HACS integration",
                "skipped",
                "nothing to compare with",
                "#/health",
                optional=True,
            )
        )
    elif not compared:
        steps.append(
            step(
                "parity",
                "Same prices and payloads as the HACS integration",
                "todo",
                "the first comparison runs within 15 minutes",
                "#/health",
            )
        )
    else:
        ok = sum(1 for r in compared if r["outcome"] == "ok")
        steps.append(
            step(
                "parity",
                "Same prices and payloads as the HACS integration",
                "done" if ok == len(compared) else "attention",
                f"{ok} of the last {len(compared)} checks matched",
                "#/health",
            )
        )

    builds = await c.recorder.list(job="emhass.mpc", limit=4)
    last = builds[0] if builds else None
    if last is None:
        steps.append(step("mpc", "MPC payload builds cleanly", "todo", "the first build runs at :13", "#/runs"))
    else:
        clean = last["outcome"] in ("ok", "dry_run") or (
            last["outcome"] == "shadow" and "refuse" not in (last["summary"] or "")
        )
        steps.append(
            step(
                "mpc",
                "MPC payload builds cleanly",
                "done" if clean else "attention",
                last["summary"] or last["outcome"],
                f"#/runs/{last['id']}",
            )
        )

    driver = mpc.driver()
    if driver == "app":
        steps.append(step("drive", "EMHASS Lens drives EMHASS", "done", "live, Auto MPC on", "#/health"))
    elif driver == "both":
        steps.append(
            step(
                "drive",
                "EMHASS Lens drives EMHASS",
                "attention",
                "both EMHASS Lens and the HACS integration are on — use Take over or Hand back",
                "#/health",
            )
        )
    else:
        mode = mpc.mode
        hint = {
            "off": "switch to Dry run when parity looks good",
            "dry_run": "use Take over when dry runs look good",
            "live": "turn Auto MPC on",
        }.get(mode, "")
        steps.append(step("drive", "EMHASS Lens drives EMHASS", "todo", f"mode {mode}; {hint}", "#/health"))

    outputs = x["outputs"]
    if not outputs.enabled():
        steps.append(
            step(
                "mqtt",
                "Home Assistant entities (MQTT)",
                "todo",
                "optional: Settings → Home Assistant outputs",
                "#/settings?section=outputs",
                optional=True,
            )
        )
    else:
        steps.append(
            step(
                "mqtt",
                "Home Assistant entities (MQTT)",
                "done" if outputs.connected else "attention",
                f"broker {outputs.broker}" if outputs.connected else (outputs.last_error or "connecting…"),
                "#/health",
                optional=True,
            )
        )
    return steps
