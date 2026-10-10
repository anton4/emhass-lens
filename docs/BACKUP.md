# Backup and restore

EMHASS Lens is one add-on among the things a wiped machine needs back. This runbook covers the App and
names what else matters; the machine itself (Home Assistant Supervised on Debian) is restored with the
Home Assistant Google Drive Backup add-on, which already backs up everything below except the Debian host.

## What is backed up where

| What | Where it lives | In the backup? |
|---|---|---|
| EMHASS Lens settings (with their history and the two secrets: eupowerprices API key, MQTT password), prices, forecasts, plans, measured history, cost-function comparisons | `app.db` in the App's `/data` | Yes: every full backup, and a partial one that includes the App |
| EMHASS Lens run details and logs | `runs.db` | No (bulky, rebuilt over time). After a restore the agreement figures and run history start from scratch |
| EMHASS's configuration and its fitted load model | the EMHASS add-on's `/data` | Yes, with that add-on |
| Automations ("EMHASS: Consolidated Inverter Control", "EV Charging …", "Qilowatt: Master Market Controller"), helpers (`input_number.emhass_target_soc`, `input_select.qilowatt_session_state`, …), the Sofar/Modbus, Solcast and Qilowatt integrations, dashboards | Home Assistant's configuration | Yes, with the Home Assistant backup |
| Mosquitto, HACS and the other add-ons | their own `/data` | Yes, with each add-on |
| The Debian host, Docker and the Supervisor installer | the machine | **No**: reinstall (see below) |
| The backup encryption password and the Google account that holds the backups | your password manager | Keep them outside the machine |

Before each backup the Supervisor runs the App's `backup_pre` (a WAL checkpoint and an integrity check of
`app.db`; a damaged file aborts the backup), so the copy is complete even though the App keeps running.

## Make sure EMHASS Lens is in the backups

1. Google Drive Backup add-on → Settings: either full backups, or a partial backup that lists **EMHASS Lens**
   among the add-ons. Keep at least a few generations; one a day is plenty for the App.
2. Turn backup encryption on there and store the password in your password manager. An encrypted backup
   that nobody can open is no backup.
3. EMHASS Lens → Health → Storage shows "Newest backup with EMHASS Lens". Health warns when it is older than
   Settings → Storage → "Warn when no backup for" (3 days by default), or when no backup includes the App.
4. Settings → Storage keeps `app.db` within its budget (200 MB by default), so a backup never balloons because
   of the App.

## Restore on a wiped machine

1. Install Debian and the Home Assistant Supervised installer the way the machine was set up before (keep
   your own notes for that step; it is outside any Home Assistant backup).
2. In the fresh Home Assistant, install the **Home Assistant Google Drive Backup** add-on first, sign in to the
   same Google account, let it list the backups in Drive, and restore the newest full backup (add-ons,
   configuration and folders). Give it time: add-ons are downloaded and started one by one.
3. Open EMHASS Lens → Health:
   - the Storage card shows "Restored from a backup taken …" and the settings revision you had; dismiss the
     note once you have looked around;
   - EMHASS is reachable and its configuration checks pass; the plan appears after the first MPC run (press
     *Run now* on the Health page's job list if you don't want to wait for the quarter-hour);
   - prices and the price forecast are there at once (the forecast is restored from the database and polled
     again only when due);
   - Settings → EMHASS mode is what it was: if it was *live*, the App starts driving EMHASS again on the next
     quarter-hour, so check the Driver card and the interlocks (the inverter, EV charger and Qilowatt
     automations) before leaving it alone;
   - the MQTT entities reappear within a minute (retained messages plus a re-send when Home Assistant starts).
4. What starts from scratch, by design: run history, the inverter/charger/market agreement figures, and the
   measured history behind the accuracy card (the new Home Assistant's recorder is empty; the App backfills
   whatever exists).

## Rehearse without touching Home Assistant

`scripts/restore-drill.sh <backup.tar>` takes a Supervisor backup file (download one from the Google Drive
Backup add-on; use its *download decrypted* option if your backups are encrypted), extracts the App's
`app.db` into a scratch directory, starts EMHASS Lens there in safe mode (it never calls EMHASS or Home
Assistant) and prints what came back: settings revision and mode, prices, forecasts, plans, measurements,
cost-function comparisons and the backup marker. Exit code 1 means the database failed its integrity check
or the App would not start. Run it once a quarter and after any big change.

## Optional

- To include `runs.db` in backups (run history survives a restore, at up to the `runs.db` budget per backup),
  remove the `backup_exclude` entry from the add-on's `config.yaml` in a local build.
- A settings export (Settings → Export) is a readable copy of the configuration, with the two secrets masked.
  It is not needed for a restore, but it is handy for a second install.
