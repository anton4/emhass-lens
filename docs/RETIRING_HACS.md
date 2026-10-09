# Retiring the HACS integration (Phase 4)

Do this only after the Phase 3 exit criteria in docs/PLAN.md are met:
- EMHASS Lens has driven EMHASS live for at least 7 days without a rollback.
- The inverter behaves as before.
- The dependency scan finds no automations or dashboards that still use `nordpool_ee_prices_*` entities.

## 1. Check nothing still uses the old entities
- **Search for references:** in Home Assistant, search Settings → Automations / Scripts / Dashboards for `nordpool_ee_prices_`.
- **Known users at migration time:**
  - `emhass-consolidated-inverter-control.yml` reads EMHASS's own `sensor.p_*`, not the integration's entities. It can trigger on `emhass_lens_plan_published` instead of `:07`.
  - `battery_energy_cost` and `nordpool_automation/notify.yaml` use `sensor.nordpool_import` / `sensor.nordpool_export`. These are not from this integration, but they can switch to `sensor.emhass_lens_import_price` / `sensor.emhass_lens_export_price`.

## 2. Final release of anton4/homeassistant-ee-nordpool
In the old repo, on a branch:
- **README:** a banner at the top.
  > **This integration is retired.** Its successor is [EMHASS Lens](https://github.com/anton4/emhass-lens), a Home Assistant App that does the same planning with everything visible in its own UI. Install it, use *Import from the HACS integration* on its Health page, then *Take over*.
- **A repair issue** in `__init__.py` `async_setup_entry`, so users see it in Settings → Repairs:
  ```python
  from homeassistant.helpers import issue_registry as ir
  ir.async_create_issue(
      hass, DOMAIN, "retired_use_emhass_lens", is_fixable=False, severity=ir.IssueSeverity.WARNING,
      translation_key="retired_use_emhass_lens", learn_more_url="https://github.com/anton4/emhass-lens",
  )
  ```
  with `strings.json` / `translations/en.json`:
  ```json
  "issues": {"retired_use_emhass_lens": {"title": "Nordpool EE Prices is retired",
    "description": "EMHASS Lens (a Home Assistant App) replaces this integration. Install it, import these settings on its Health page, use Take over, then remove this integration."}}
  ```
- **Release:** bump `manifest.json` version (e.g. 2026.11.0) and make a GitHub release so HACS offers the update.

## 3. Remove it from your Home Assistant
1. **Backup:** take a full Home Assistant backup.
2. **Remove the integration:** Settings → Devices & services → Nordpool EE Prices → Delete. Then remove it in HACS.
3. **Clean up:** remove any recorder excludes or customizations for its large attributes.

## 4. Archive the repo
After about a month without problems, archive anton4/homeassistant-ee-nordpool on GitHub.

## Rollback at any point
1. **Reinstall:** reinstall the integration's last release from HACS and restore its config entry from the backup.
2. **Hand back:** in EMHASS Lens, use **Hand back** on the Health page.
