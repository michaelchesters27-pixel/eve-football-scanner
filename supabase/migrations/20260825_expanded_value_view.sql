-- Expanded Market Lab value fields. Same schema change as PATCH_EXPANDED_VALUE_V1.sql.
drop view if exists public.scanner_expanded_markets;

create view public.scanner_expanded_markets
with (security_invoker = true)
as
select
  p.id,
  f.id as "fixtureId",
  c.name as country,
  l.name as league,
  ht.name as "homeTeam",
  at.name as "awayTeam",
  to_char(f.kickoff at time zone 'Europe/London', 'HH24:MI') as kickoff,
  f.kickoff as "kickoffUtc",
  p.market,
  p.selection,
  p.confidence,
  p.grade,
  p.data_quality as "dataQuality",
  p.evidence,
  fs.selection_key as "selectionKey",
  fs.features,
  case when r.id is null then null else jsonb_build_object('name',r.name,'cardsPerMatch',rp.yellow_cards_per_match,'matchesSample',rp.matches_sample) end as referee,
  coalesce(mmc.lineups_confirmed,false) as "lineupsConfirmed",
  coalesce(mmc.referee_confirmed,false) as "refereeConfirmed",
  case when p.fair_probability is null then null else round((p.fair_probability * 100)::numeric, 1) end as "fairProbability",
  case when p.fair_probability is null or p.fair_probability <= 0 then null else round((1 / p.fair_probability)::numeric, 2) end as "fairOdds",
  bo.bookmaker as "bestBookmaker",
  bo.decimal_odds as "bestOdds",
  bo.captured_at as "oddsCapturedAt",
  case when bo.decimal_odds is null then null else round((100 / bo.decimal_odds)::numeric, 1) end as "impliedProbability",
  case when bo.decimal_odds is null or p.fair_probability is null then null else round(((p.fair_probability - (1 / bo.decimal_odds)) * 100)::numeric, 1) end as "edgePct",
  case when bo.decimal_odds is null or p.fair_probability is null then null else round(((p.fair_probability * bo.decimal_odds - 1) * 100)::numeric, 1) end as "expectedValuePct",
  case
    when p.fair_probability is null then 'uncalibrated'
    when bo.decimal_odds is null then 'waiting'
    when (p.fair_probability - (1 / bo.decimal_odds)) >= 0.07 and (p.fair_probability * bo.decimal_odds - 1) >= 0.10 then 'strong'
    when (p.fair_probability - (1 / bo.decimal_odds)) >= 0.05 and (p.fair_probability * bo.decimal_odds - 1) >= 0.05 then 'value'
    else 'no_value'
  end as "valueStatus"
from public.predictions p
join public.feature_snapshots fs on fs.id = p.feature_snapshot_id
join public.fixtures f on f.id = p.fixture_id
join public.leagues l on l.id = f.league_id
join public.countries c on c.id = l.country_id
join public.teams ht on ht.id = f.home_team_id
join public.teams at on at.id = f.away_team_id
left join public.manual_match_context mmc on mmc.fixture_id = f.id
left join public.referees r on r.id = f.referee_id
left join lateral (
  select yellow_cards_per_match, matches_sample
  from public.referee_profiles rp0
  where rp0.referee_id = r.id
  order by rp0.as_of_date desc
  limit 1
) rp on true
left join lateral (
  select os.bookmaker, os.decimal_odds, os.captured_at
  from public.odds_snapshots os
  where os.prediction_id = p.id and os.captured_at >= now() - interval '8 hours'
  order by os.decimal_odds desc, os.captured_at desc
  limit 1
) bo on true
where p.model_version = 'v1-expanded-research'
  and p.publish_status = 'published'
  and f.status in ('scheduled','live')
  and f.kickoff >= now() - interval '3 hours'
order by p.confidence desc;

grant select on public.scanner_expanded_markets to anon, authenticated;
