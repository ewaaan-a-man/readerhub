# ReaderHub ops notes

## Why the database used to vanish
The app is a zero-dependency Node server storing all data in `data/db.json`
inside the container. Render's free tier wipes the filesystem on every
redeploy AND on idle spin-down (15 min without traffic), so users, orders
and messages were periodically erased, and the admin account was re-seeded
with a random password each time.

## Current setup (persistent)
Storage now lives in Turso (free hosted SQLite), read/written over HTTP:
- `TURSO_DATABASE_URL` — e.g. `libsql://readerhub-xxxx.turso.io`
- `TURSO_AUTH_TOKEN` — from `turso db tokens create readerhub`
Set both in Render -> Environment. Set these too while you're there:
- `ADMIN_EMAIL` — your login email
- `ADMIN_PASS` — your admin password
(Admin is auto-created on first boot; on every later boot your existing
remote data is loaded, so the credentials are only used if no admin exists.)

Data now survives redeploys, spin-downs and restarts. Nothing is stored in
git (repo is public); `.gitignore` excludes `data/`.

## Failure behaviour
- If Turso is unreachable at boot, the server retries (3x, backoff) and
  will NEVER overwrite the remote copy with empty/fresh data — it serves
  in-memory and keeps retrying every 30s until the cloud is readable.
- Saves are serialized; a failed save logs an error and the next save
  re-writes the full state, so the remote converges to the latest data.

## Local dev
No env vars needed — falls back to `data/db.json` on disk.
