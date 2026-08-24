-- EVE Football Scanner - Value Engine
-- Adds live bookmaker price comparison to the published scanner view.
-- Fair probability is populated by the server-side value engine from
-- conservative walk-forward calibration, not from the raw research score.

create index if not exists odds_prediction_odds_idx
  on public.odds_snapshots(prediction_id, decimal_odds desc, captured_at desc);

do $$ begin
  create policy "public read published odds" on public.odds_snapshots
    for select to anon, authenticated
    using (
      exists (
        select 1 from public.predictions p
        where p.id = odds_snapshots.prediction_id
          and p.publish_status = 'published'
      )
    );
exception when duplicate_object then null; end $$;

create or replace view public.scanner_best_bets
with (security_invoker = true)
as
select
  p.id,
  c.name as country,
  l.name as league,
  ht.name as "homeTeam",
  at.name as "awayTeam",
  to_char(f.kickoff at time zone 'Europe/London', 'HH24:MI') as kickoff,
  p.market,
  p.selection,
  p.confidence,
  p.grade,
  p.data_quality as "dataQuality",
  p.evidence,
  case when r.id is null then null else jsonb_build_object(
    'name', r.name,
    'cardsPerMatch', rp.yellow_cards_per_match,
    'foulsPerMatch', rp.fouls_per_match
  ) end as referee,
  null::text as "researchNote",
  case when p.fair_probability is null then null else round((p.fair_probability * 100)::numeric, 1) end as "fairProbability",
  case when p.fair_probability is null or p.fair_probability <= 0 then null else round((1 / p.fair_probability)::numeric, 2) end as "fairOdds",
  bo.bookmaker as "bestBookmaker",
  bo.decimal_odds as "bestOdds",
  bo.captured_at as "oddsCapturedAt",
  case when bo.decimal_odds is null then null else round((100 / bo.decimal_odds)::numeric, 1) end as "impliedProbability",
  case
    when bo.decimal_odds is null or p.fair_probability is null then null
    else round(((p.fair_probability - (1 / bo.decimal_odds)) * 100)::numeric, 1)
  end as "edgePct",
  case
    when bo.decimal_odds is null or p.fair_probability is null then null
    else round(((p.fair_probability * bo.decimal_odds - 1) * 100)::numeric, 1)
  end as "expectedValuePct",
  case
    when p.fair_probability is null then 'uncalibrated'
    when bo.decimal_odds is null then 'waiting'
    when (p.fair_probability - (1 / bo.decimal_odds)) >= 0.07
      and (p.fair_probability * bo.decimal_odds - 1) >= 0.10 then 'strong'
    when (p.fair_probability - (1 / bo.decimal_odds)) >= 0.05
      and (p.fair_probability * bo.decimal_odds - 1) >= 0.05 then 'value'
    else 'no_value'
  end as "valueStatus"
from public.predictions p
join public.fixtures f on f.id = p.fixture_id
join public.leagues l on l.id = f.league_id
join public.countries c on c.id = l.country_id
join public.teams ht on ht.id = f.home_team_id
join public.teams at on at.id = f.away_team_id
left join public.referees r on r.id = f.referee_id
left join lateral (
  select yellow_cards_per_match, fouls_per_match
  from public.referee_profiles rp0
  where rp0.referee_id = r.id
  order by rp0.as_of_date desc
  limit 1
) rp on true
left join lateral (
  select os.bookmaker, os.decimal_odds, os.captured_at
  from public.odds_snapshots os
  where os.prediction_id = p.id
    and os.captured_at >= now() - interval '8 hours'
  order by os.decimal_odds desc, os.captured_at desc
  limit 1
) bo on true
where p.publish_status = 'published'
  and f.status in ('scheduled','live')
  and f.kickoff >= now() - interval '3 hours'
order by
  case
    when bo.decimal_odds is not null and p.fair_probability is not null
      then (p.fair_probability * bo.decimal_odds - 1)
    else -1
  end desc,
  p.confidence desc;

comment on table public.odds_snapshots is 'Bookmaker prices captured for exact EVE selections. Used by the Value Engine and closing-line tracking.';
comment on view public.scanner_best_bets is 'Published EVE signals enriched with conservative fair probability, best recent bookmaker price, implied probability, edge and expected value.';
