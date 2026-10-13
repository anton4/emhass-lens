#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["playwright>=1.49"]
# ///
"""Take the README screenshots (docs/screenshots/*.png) from a running EMHASS Lens.

    uv run scripts/readme_screenshots.py --base http://localhost:8099

Point --base at the App's read-only direct port (Configuration → Network) or at a standalone install. Only
GET requests are made. The status response is patched to "writable" so the read-only banner and the
disabled buttons stay out of the shots. Uses the installed Google Chrome, so nothing is downloaded.
Look at every image before committing: they show live data.
"""

import argparse
import json
import re
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from playwright.sync_api import Page, Route, sync_playwright


@dataclass(frozen=True)
class Shot:
    name: str
    route: str | None  # None: the latest successful MPC run
    panel: str | None = None  # the h2 of the one panel to shoot; None: the viewport


SHOTS = [
    Shot("plan-timeline", "/", panel="Timeline"),
    Shot("plan", "/"),
    Shot("inputs", "/inputs"),
    Shot("run", None),
    Shot("runs", "/runs"),
]

# Notices ("updated or restarted", …) come and go; keep them out of the shots
HIDE_CSS = ".banners { display: none !important; }"
PANEL_MARGIN = 24


def latest_mpc_run(base: str) -> int:
    url = f"{base}/api/runs?job=emhass.mpc&outcome=ok&limit=1"
    with urllib.request.urlopen(url, timeout=10) as r:
        runs = json.load(r)
    if not runs:
        sys.exit("No successful emhass.mpc run to show")
    return int(runs[0]["id"])


def writable(route: Route) -> None:
    response = route.fetch()
    body = response.json()
    body.update(writable=True, write_block_reason=None)
    route.fulfill(response=response, json=body)


def shoot(page: Page, url: str, shot: Shot, path: Path) -> None:
    page.goto(url, wait_until="load")
    page.add_style_tag(content=HIDE_CSS)
    page.wait_for_selector(".panel", timeout=20_000)
    page.mouse.move(0, 0)
    # The live-update stream keeps a request open, so "networkidle" never comes; give the charts time instead
    page.wait_for_timeout(3_000)
    if shot.panel:
        heading = page.locator("h2", has_text=re.compile(f"^{re.escape(shot.panel)}$"))
        box = page.locator("section.panel", has=heading).first.bounding_box()
        if box is None:
            sys.exit(f"{shot.name}: no panel {shot.panel!r} on {url}")
        width = page.viewport_size["width"] if page.viewport_size else 1440
        clip = {
            "x": 0,
            "y": box["y"] - PANEL_MARGIN,
            "width": width,
            "height": box["height"] + 2 * PANEL_MARGIN,
        }
        page.screenshot(path=path, clip=clip, full_page=True)
    else:
        page.screenshot(path=path)
    print(f"{path}  {path.stat().st_size // 1024} KB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", default="http://localhost:8099", help="EMHASS Lens URL (default: %(default)s)")
    parser.add_argument("--out", type=Path, default=Path(__file__).parent.parent / "docs" / "screenshots")
    parser.add_argument("--only", nargs="*", help="take only these shots (file names without .png)")
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--height", type=int, default=900)
    parser.add_argument("--scale", type=float, default=2)
    args = parser.parse_args()
    base = args.base.rstrip("/")
    args.out.mkdir(parents=True, exist_ok=True)

    shots = [s for s in SHOTS if not args.only or s.name in args.only]
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome")
        context = browser.new_context(
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=args.scale,
            color_scheme="light",
            timezone_id="Europe/Tallinn",
            locale="en-GB",
        )
        page = context.new_page()
        page.route(re.compile(r"/api/status(\?|$)"), writable)
        for shot in shots:
            route = shot.route or f"/runs/{latest_mpc_run(base)}"
            shoot(page, f"{base}/#{route}", shot, args.out / f"{shot.name}.png")
        browser.close()


if __name__ == "__main__":
    main()
