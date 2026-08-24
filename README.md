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
Collector / normaliser
      |
      v
Supabase Free project
      |
      +--> feature snapshots
      +--> referee statistics
      +--> model predictions
      +--> results / backtests
      |
      v
EVE scoring + ranking
      |
      v
Netlify dashboard
```

## Current state

The repository contains the first production-ready application shell, database migration and a deterministic v0 scoring engine. Until the separate free Supabase project is connected, the dashboard deliberately runs in **DEMO / RESEARCH MODE** using labelled sample fixtures.

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

## Supabase

Run `supabase/migrations/001_initial_schema.sql` against the dedicated free Supabase project only.

Required frontend variables:

```text
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Do not place a Supabase service-role key in Netlify frontend variables.

## Model status

The v0 weights are intentionally transparent and provisional. They exist so the entire scanner can operate end-to-end while historical data is collected. They must be replaced/calibrated based on backtesting, calibration error, ROI at recorded prices and closing-line value before the system is treated as a betting model.
