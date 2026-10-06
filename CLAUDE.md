# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

caobaquintas.com — a lot-sale landing page for Caoba Quintas (Bagaces, Guanacaste, Costa Rica),
plus a WhatsApp lead-capture bot. Three independently deployable units sharing one D1 database:

- **Static site** (`public/`) — Cloudflare Pages, project `caoba-quintas`.
- **Leads worker** (`worker/index.js`) — API at `caobaquintas.com/api/*`, admin dashboard at `/api/admin`.
- **Bot worker** (`worker/bot.js` + `worker/engine.js`) — WhatsApp webhook at `caobaquintas.com/webhook/wa*`.

Full operational reference (deploy, rollback, secrets, DB access, troubleshooting) lives in
`RUNBOOK.md` — read it before touching infra, and update it in the same PR that changes any.
Session history and decisions are logged in `BITACORA.md`.

## Context and branches

- Lives in `~/Work/pujolbadi/caoba-quintas-landing` (repo `pujolbadi/caoba-quintas-landing`);
  identity, servers and conventions are in `~/Work/pujolbadi/CLAUDE.md`.
- The org branch policy applies (`documentacion/politica-de-ramas.md`): `main` is production; changes
  go in short branches (`feature/`, `fix/`, `chore/`, `docs/`) back to `main` through a PR with
  Squash and merge. The static site deploys itself from `main`; the two Workers are deployed by hand
  with `wrangler deploy`, always from `main`.

## Commands

```bash
npm test                                  # runs worker/*.test.js (node:test), 15 tests
node --test worker/engine.test.js         # single file
node --test worker/engine.test.js -t "sin sesión"  # single test by name pattern

npx wrangler pages dev public             # local dev, static site
npx wrangler dev --config config/wrangler.toml       # local dev, leads worker
npx wrangler dev --config config/wrangler.bot.toml   # local dev, bot worker

npx wrangler deploy --config config/wrangler.toml       # deploy leads worker
npx wrangler deploy --config config/wrangler.bot.toml   # deploy bot worker
# static site deploys automatically on push to main via .github/workflows/deploy-pages.yml
```

Wrangler config files live in `config/`, not the repo root, so every wrangler command needs
`--config` — the `main` path inside each `.toml` is resolved relative to the config file, not cwd.

## Architecture

### Bot: pure core + injected ports

`worker/engine.js` is the whole conversation logic, and it is intentionally free of I/O — no
`env`, no `Date.now()`, no SQL, no `fetch`. `decide(session, msg, config, nowMs)` is a pure
function returning `{ reply, effects }`; effects are plain data describing what should happen
(`saveSession`, `insertLead`, `notifyAdvisor`), not actions. `runEngine(msg, deps)` is the
application service that drives one conversation turn through injected ports (`sessions`,
`sender`, `dedup`, `applyEffect`, `clock`). This split is what makes `worker/engine.test.js` (pure
decision table) and `worker/run-engine.test.js` (ordering/effects with in-memory fakes) possible
without touching D1 or WhatsApp.

`worker/bot.js` is the only place that touches the real world: it builds the concrete ports in
`makeDeps(env)` (D1 queries, `sendTextDirect`, webhook signature verification) and wires them into
`runEngine`.

**Invariant enforced by `runEngine`**: send the reply *first*, apply effects only after a
successful send. If sending fails, the dedup claim on the inbound message is released so the
provider's retry isn't silently swallowed — but effects are never double-applied, and a duplicate
inbound message is dropped before any decision is made (`dedup.claim`).

Two WhatsApp providers are supported (`WA_PROVIDER` = `evolution` | `meta`), each with its own
payload shape (`parseEvolution` / `parseMeta` in `bot.js`) and its own webhook auth scheme (HMAC
signature for Meta, shared secret for others) — `verifyWebhook` branches on provider.

### Static site: single-file, no build

`public/index.html` (~3900 lines) is a hand-authored, pre-compiled React tree (`React.createElement`
calls, no JSX/build step at deploy time) plus a Leaflet map. `public/` is exactly what
`deploy-pages.yml` publishes — nothing outside it reaches production, and internal links are
relative so the folder is self-contained.

Key landmarks in `index.html`:
- `LOTS` (~line 793) — the lot inventory shown as cards (id, price, m², status).
- `LOTS_GEO` (~line 2347) — a GeoJSON `FeatureCollection` of lot polygons.
- `LeafletMap` (~line 2869) — renders the map; `availableMap` (~line 2907) hand-maps
  `LOTS_GEO.features` array index → lot name, since the polygons carry no lot identifier of their
  own.

**Known issue**: the `LOTS_GEO` polygons do not match the real parcels (broken rings, areas that
don't match the `m²` in `LOTS`) — there is no surveyed plan or KML, only a master-plan image and
satellite imagery. `availableMap`'s index-based wiring is fragile: reordering or editing
`LOTS_GEO.features` silently breaks which card lights up which polygon. When updating lot
inventory or availability, `LOTS` and `availableMap` must be changed together and cross-checked
against the master-plan image.

### Data flow: leads

Both the web form (`worker/index.js` → `POST /api/leads`) and the bot
(`engine.js`'s `insertLead` effect) write to the same `leads` table, distinguished by `fuente`
(`hero`, `wa_bot`, etc.). The leads worker sends an email notification via Resend on new leads if
`RESEND_API_KEY`/`NOTIFY_EMAIL` are set; the bot notifies an advisor over WhatsApp via
`NOTIFY_WA_NUM` instead, best-effort (failure doesn't fail the request in either case).

### Database

Single D1 database (`caoba-leads`) shared by both workers. Migrations are plain numbered SQL files
in `migrations/`, applied manually (no migration runner) — see `RUNBOOK.md` §9 for the
`wrangler d1 execute` invocation. Tables: `leads` (shared), `wa_sessions` + `wa_inbound` (bot only,
the latter is a dedup table opportunistically pruned in `bot.js`'s `dedup.claim`).

## Conventions

- Comments and identifiers in this repo are in Spanish — match that when editing.
- No secrets in code or `.toml` files — only variable *names* appear in `config/*.toml` as
  comments; actual values are set via `wrangler secret put` (see `RUNBOOK.md` §3/§7).
- `secrets/credenciales_caoba.md` is a local, gitignored file with real credential values — never
  read it into anything that leaves the machine.
