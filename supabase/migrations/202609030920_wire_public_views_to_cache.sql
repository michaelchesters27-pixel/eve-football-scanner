-- Production repair: browser-facing Best Bets and Market Lab now read last-known-good caches.
-- Fresh odds are selected directly from odds_snapshots so a stale high quote cannot hide a fresh lower quote.

drop view public.scanner_best_bets;
drop view public.scanner_expanded_markets;

create view public.scanner_best_bets
with (security_invoker = false)
as
select
  c.id, c."fixtureId", c.country, c.league, c."homeTeam", c."awayTeam", c.kickoff, c."kickoffUtc",
  c.market, c.selection, c.confidence, c.grade, c."dataQuality", c.evidence, c.referee,
  c."fairProbability", c."fairOdds",
  case when bo.captured_at is not null then bo.bookmaker else null::text end as "bestBookmaker",
  case when bo.captured_at is not null then bo.decimal_odds else null::numeric end as "bestOdds",
  case when bo.captured_at is not null then bo.captured_at else null::timestamptz end as "oddsCapturedAt",
  case when bo.decimal_odds is null then null::numeric else round(100::numeric / bo.decimal_odds, 1) end as "impliedProbability",
  case when bo.decimal_odds is null then null::numeric else round(c."fairProbability" - (100::numeric / bo.decimal_odds), 1) end as "edgePct",
  case when bo.decimal_odds is null then null::numeric else round((((c."fairProbability" / 100::numeric) * bo.decimal_odds) - 1::numeric) * 100::numeric, 1) end as "expectedValuePct",
  case
    when bo.decimal_odds is null then 'waiting'::text
    when (c."fairProbability" - (100::numeric / bo.decimal_odds)) >= 7::numeric
      and ((((c."fairProbability" / 100::numeric) * bo.decimal_odds) - 1::numeric) * 100::numeric) >= 10::numeric then 'strong'::text
    when (c."fairProbability" - (100::numeric / bo.decimal_odds)) >= 5::numeric
      and ((((c."fairProbability" / 100::numeric) * bo.decimal_odds) - 1::numeric) * 100::numeric) >= 5::numeric then 'value'::text
    else 'no_value'::text
  end as "valueStatus"
from public.scanner_best_bets_public_cache c
left join lateral (
  select os.bookmaker, os.decimal_odds, os.captured_at
  from public.odds_snapshots os
  where os.prediction_id = c.id
    and os.captured_at >= now() - interval '2 hours'
  order by os.decimal_odds desc, os.captured_at desc
  limit 1
) bo on true
where c."kickoffUtc" > now()
  and c."fairProbability" is not null
  and c.cache_refreshed_at >= now() - interval '2 hours';

create view public.scanner_expanded_markets
with (security_invoker = false)
as
select
  c.id, c."fixtureId", c.country, c.league, c."homeTeam", c."awayTeam", c.kickoff, c."kickoffUtc",
  c.market, c.selection, c.confidence, c.grade, c."dataQuality", c.evidence, c."selectionKey", c.features,
  c.referee, c."lineupsConfirmed", c."refereeConfirmed", c."fairProbability", c."fairOdds",
  case when bo.captured_at is not null then bo.bookmaker else null::text end as "bestBookmaker",
  case when bo.captured_at is not null then bo.decimal_odds else null::numeric end as "bestOdds",
  case when bo.captured_at is not null then bo.captured_at else null::timestamptz end as "oddsCapturedAt",
  case when bo.decimal_odds is null then null::numeric else round(100::numeric / bo.decimal_odds, 1) end as "impliedProbability",
  case when bo.decimal_odds is null then null::numeric else round(c."fairProbability" - (100::numeric / bo.decimal_odds), 1) end as "edgePct",
  case when bo.decimal_odds is null then null::numeric else round((((c."fairProbability" / 100::numeric) * bo.decimal_odds) - 1::numeric) * 100::numeric, 1) end as "expectedValuePct",
  case
    when bo.decimal_odds is null then 'waiting'::text
    when (c."fairProbability" - (100::numeric / bo.decimal_odds)) >= 7::numeric
      and ((((c."fairProbability" / 100::numeric) * bo.decimal_odds) - 1::numeric) * 100::numeric) >= 10::numeric then 'strong'::text
    when (c."fairProbability" - (100::numeric / bo.decimal_odds)) >= 5::numeric
      and ((((c."fairProbability" / 100::numeric) * bo.decimal_odds) - 1::numeric) * 100::numeric) >= 5::numeric then 'value'::text
    else 'no_value'::text
  end as "valueStatus"
from public.scanner_expanded_markets_public_cache c
left join lateral (
  select os.bookmaker, os.decimal_odds, os.captured_at
  from public.odds_snapshots os
  where os.prediction_id = c.id
    and os.captured_at >= now() - interval '2 hours'
  order by os.decimal_odds desc, os.captured_at desc
  limit 1
) bo on true
where c."kickoffUtc" > now()
  and c."fairProbability" is not null
  and c.cache_refreshed_at >= now() - interval '2 hours';

grant select on public.scanner_best_bets to anon, authenticated;
grant select on public.scanner_expanded_markets to anon, authenticated;
revoke all on public.scanner_best_bets_public_cache from anon, authenticated;
revoke all on public.scanner_expanded_markets_public_cache from anon, authenticated;
revoke all on public.scanner_publication_state from anon, authenticated;
