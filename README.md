# EVE Football Scanner

EVE Football Scanner is a free-data football analysis platform focused on three statistical markets:

- Yellow cards
- Corners
- Goals

Referee statistics are a first-class input to the card model. The scanner also accounts for home/away splits, recent form, opponent tendencies, head-to-head history, match context and eventually bookmaker price/value.

## Product principles

1. **£0 Supabase operating target** — the project is designed for a separate Supabase Free project and must not depend on the paid EVE databases.
2. **No invented data** — a market is rejected when required evidence is missing.
3. **Evidence before confidence** — every score exposes the factors behind it.
4. **Backtest before trust** — initial scores are research heuristics until calibrated against historical out-of-sample results.
5. **Narrow, high-quality shortlist** — EVE ranks the strongest opportunities instead of predicting every match.
6. **Free-data-first** — collection adapters are designed around permissible free/public sources, with source substitution when a provider is unavailable.

## Architecture

```text
Free football sources
      |
      v
Netlify scheduled collector / normaliser
      |
      v
Dedicated Supabase Free project
      |
      +--> fixtures + compact match stats
      +--> referee profiles
      +--> pre-match feature snapshots
      +--> model predictions
      +--> settled results / performance
      |
      v
EVE scoring + ranking
      |
      v
Netlify dashboard
```

## Current build

The repository now contains:

- Responsive React/Vite EVE scanner dashboard
- Cards, corners and goals filters
- Transparent evidence breakdown for every selection
- Deterministic v0 research scoring engine
- Dedicated referee factor in the card model
- Free-tier Supabase schema with RLS
- Compact historical match-stat storage
- Automatic referee-profile calculation
- Scheduled free Football-Data.co.uk current-season ingestion
- Scheduled model scanning of upcoming fixtures
- Automatic result settlement
- Public hit-rate performance view
- Netlify deployment configuration

Until the separate free Supabase project is connected, the dashboard deliberately runs in **DEMO / RESEARCH MODE** using clearly labelled sample fixtures.

## Free historical source

The first production adapter uses Football-Data.co.uk CSV files. They provide free historical results and, for supported leagues/seasons, match statistics including goals, corners, bookings, fouls and referee names. EVE stores only the compact fields required by the model rather than provider pages/raw payloads.

FotMob/other free sources remain candidate adapters for richer current-day information such as referee appointments, but an adapter should only be enabled after its access method is confirmed to be reliable and appropriate for automation.

## Supported v0 leagues

- England: Premier League, Championship
- Scotland: Premiership
- Germany: Bundesliga
- Italy: Serie A
- Spain: La Liga
- France: Ligue 1
- Netherlands: Eredivisie
- Belgium: Pro League
- Portugal: Primeira Liga
- Turkey: Super Lig

## Local development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` when the free Supabase project is ready.

## Netlify

Build command: `npm run build`  
Publish directory: `dist`

The included `netlify.toml` provides these settings automatically.

### Frontend variables

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

### Server-only Netlify variables

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

`SUPABASE_SERVICE_ROLE_KEY` must remain server-only. Never prefix it with `VITE_` and never expose it to browser code.

## Supabase setup

Apply migrations to the **dedicated free EVE Football project only**, in order:

```text
supabase/migrations/001_initial_schema.sql
supabase/migrations/002_analysis_views.sql
supabase/migrations/003_settlement_and_performance.sql
```

Do **not** run these migrations against `eve-algo-lab`, `evolution discovery lab`, or any other paid EVE Supabase project.

## Scheduled jobs

Netlify functions are prepared for:

1. `05:15 UTC` — current-season fixtures/results/statistics sync
2. `05:25 UTC` — settle completed EVE predictions
3. `05:35 UTC` — generate the next seven days of card/corner/goal candidates

The exact schedule can be changed later if fresh-source testing shows a better cadence.

## Model status

The v0 weights are transparent and provisional. They exist so the scanner can operate end-to-end while historical data is collected. They must be calibrated using genuine historical pre-match snapshots, out-of-sample testing, calibration error, hit rate by league/market, ROI at recorded prices and closing-line value before EVE is treated as having a proven betting edge.
