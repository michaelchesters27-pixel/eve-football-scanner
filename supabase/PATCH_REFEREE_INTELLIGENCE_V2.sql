-- EVE Football Scanner — REFEREE INTELLIGENCE V2
-- Run once in the dedicated eve-football-scanner Supabase project.
-- Fixes the historical referee profile so missing match stats are NEVER treated as zero.

create or replace function public.refresh_referee_profiles()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  insert into public.referee_profiles (
    referee_id,
    as_of_date,
    matches_sample,
    yellow_cards_per_match,
    red_cards_per_match,
    fouls_per_match,
    home_yellows_per_match,
    away_yellows_per_match,
    source
  )
  select
    f.referee_id,
    current_date,
    count(*) filter (
      where hs.yellow_cards is not null
        and aw.yellow_cards is not null
    )::smallint as matches_sample,
    round(avg(
      case
        when hs.yellow_cards is not null and aw.yellow_cards is not null
        then hs.yellow_cards + aw.yellow_cards
        else null
      end
    )::numeric, 2) as yellow_cards_per_match,
    round(avg(
      case
        when hs.red_cards is not null and aw.red_cards is not null
        then hs.red_cards + aw.red_cards
        else null
      end
    )::numeric, 3) as red_cards_per_match,
    round(avg(
      case
        when hs.fouls is not null and aw.fouls is not null
        then hs.fouls + aw.fouls
        else null
      end
    )::numeric, 2) as fouls_per_match,
    round(avg(
      case
        when hs.yellow_cards is not null and aw.yellow_cards is not null
        then hs.yellow_cards
        else null
      end
    )::numeric, 2) as home_yellows_per_match,
    round(avg(
      case
        when hs.yellow_cards is not null and aw.yellow_cards is not null
        then aw.yellow_cards
        else null
      end
    )::numeric, 2) as away_yellows_per_match,
    'eve-derived'
  from public.fixtures f
  join public.team_match_stats hs
    on hs.fixture_id = f.id and hs.team_id = f.home_team_id
  join public.team_match_stats aw
    on aw.fixture_id = f.id and aw.team_id = f.away_team_id
  where f.status = 'finished'
    and f.referee_id is not null
    and f.kickoff >= now() - interval '730 days'
  group by f.referee_id
  having count(*) filter (
    where hs.yellow_cards is not null
      and aw.yellow_cards is not null
  ) >= 3
  on conflict (referee_id, as_of_date, source)
  do update set
    matches_sample = excluded.matches_sample,
    yellow_cards_per_match = excluded.yellow_cards_per_match,
    red_cards_per_match = excluded.red_cards_per_match,
    fouls_per_match = excluded.fouls_per_match,
    home_yellows_per_match = excluded.home_yellows_per_match,
    away_yellows_per_match = excluded.away_yellows_per_match,
    created_at = now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Refresh immediately so existing referee profiles stop carrying false zeroes.
select public.refresh_referee_profiles() as referee_profiles_refreshed;

comment on function public.refresh_referee_profiles() is
'EVE referee profile refresh V2: averages only observed values; missing cards/reds/fouls remain missing instead of being converted to zero.';

select 'EVE Referee Intelligence V2 patch complete' as status;
