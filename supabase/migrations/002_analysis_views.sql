-- EVE Football Scanner v0 analysis helpers

alter table public.fixtures
  add column if not exists half_time_home_goals smallint,
  add column if not exists half_time_away_goals smallint;

create or replace view public.team_match_flat
with (security_invoker = true)
as
select
  f.id as fixture_id,
  f.kickoff,
  f.league_id,
  f.referee_id,
  f.status,
  hs.team_id,
  f.away_team_id as opponent_team_id,
  'home'::text as venue,
  hs.goals,
  hs.yellow_cards,
  hs.red_cards,
  hs.corners,
  hs.fouls,
  hs.shots,
  hs.shots_on_target,
  hs.xg,
  aw.yellow_cards as opponent_yellow_cards,
  aw.corners as opponent_corners,
  aw.goals as opponent_goals,
  f.home_goals,
  f.away_goals,
  f.half_time_home_goals,
  f.half_time_away_goals
from public.fixtures f
join public.team_match_stats hs on hs.fixture_id = f.id and hs.team_id = f.home_team_id
join public.team_match_stats aw on aw.fixture_id = f.id and aw.team_id = f.away_team_id
where f.status = 'finished'
union all
select
  f.id as fixture_id,
  f.kickoff,
  f.league_id,
  f.referee_id,
  f.status,
  aw.team_id,
  f.home_team_id as opponent_team_id,
  'away'::text as venue,
  aw.goals,
  aw.yellow_cards,
  aw.red_cards,
  aw.corners,
  aw.fouls,
  aw.shots,
  aw.shots_on_target,
  aw.xg,
  hs.yellow_cards as opponent_yellow_cards,
  hs.corners as opponent_corners,
  hs.goals as opponent_goals,
  f.home_goals,
  f.away_goals,
  f.half_time_home_goals,
  f.half_time_away_goals
from public.fixtures f
join public.team_match_stats hs on hs.fixture_id = f.id and hs.team_id = f.home_team_id
join public.team_match_stats aw on aw.fixture_id = f.id and aw.team_id = f.away_team_id
where f.status = 'finished';

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
    count(*)::smallint,
    round(avg(coalesce(hs.yellow_cards,0) + coalesce(aw.yellow_cards,0))::numeric, 2),
    round(avg(coalesce(hs.red_cards,0) + coalesce(aw.red_cards,0))::numeric, 3),
    round(avg(coalesce(hs.fouls,0) + coalesce(aw.fouls,0))::numeric, 2),
    round(avg(coalesce(hs.yellow_cards,0))::numeric, 2),
    round(avg(coalesce(aw.yellow_cards,0))::numeric, 2),
    'eve-derived'
  from public.fixtures f
  join public.team_match_stats hs on hs.fixture_id = f.id and hs.team_id = f.home_team_id
  join public.team_match_stats aw on aw.fixture_id = f.id and aw.team_id = f.away_team_id
  where f.status = 'finished'
    and f.referee_id is not null
    and f.kickoff >= now() - interval '730 days'
  group by f.referee_id
  having count(*) >= 3
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

revoke all on function public.refresh_referee_profiles() from public;
revoke all on function public.refresh_referee_profiles() from anon;
revoke all on function public.refresh_referee_profiles() from authenticated;

comment on view public.team_match_flat is 'Service-side modelling view. One row per team per completed fixture with opponent context.';
comment on function public.refresh_referee_profiles() is 'Rebuilds rolling two-year referee card/foul profiles from stored completed matches.';
