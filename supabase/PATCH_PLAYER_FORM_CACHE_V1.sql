-- EVE Football Scanner — PLAYER FORM CACHE V1
-- Run ONCE in the dedicated FREE eve-football-scanner Supabase project.
-- Adds a fixture-scoped recent-player-form cache so XI intelligence can use
-- 5-10 recent appearances even when those historical FotMob matches do not
-- map cleanly onto EVE's existing team-history fixture rows.

begin;

create table if not exists public.fixture_player_form_cache (
  fixture_id uuid not null references public.fixtures(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  team_id uuid not null references public.teams(id) on delete cascade,
  matches_sample smallint not null default 0,
  avg_minutes numeric(7,2),
  avg_shots numeric(7,2),
  avg_shots_on_target numeric(7,2),
  avg_goals numeric(7,2),
  avg_assists numeric(7,2),
  avg_yellow_cards numeric(7,2),
  avg_red_cards numeric(7,2),
  avg_fouls_committed numeric(7,2),
  avg_fouls_won numeric(7,2),
  avg_xg numeric(8,3),
  avg_xa numeric(8,3),
  source text not null default 'fotmob-player-matches',
  source_match_ids jsonb not null default '[]'::jsonb,
  refreshed_at timestamptz not null default now(),
  primary key (fixture_id, player_id)
);

create index if not exists fixture_player_form_cache_fixture_team_idx
  on public.fixture_player_form_cache(fixture_id, team_id, matches_sample desc);

alter table public.fixture_player_form_cache enable row level security;

do $$
begin
  create policy "public read current fixture player form cache"
  on public.fixture_player_form_cache
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.fixture_lineups fl
      where fl.fixture_id = fixture_player_form_cache.fixture_id
        and fl.player_id = fixture_player_form_cache.player_id
        and fl.is_starting = true
    )
  );
exception when duplicate_object then null;
end $$;

grant select on public.fixture_player_form_cache to anon, authenticated;

-- The UI can still show the real sample count at 0-4 matches, but the averages
-- remain NULL until at least five appearances exist. This makes "thin history"
-- visibly different from a genuine zero and prevents the existing XI model from
-- treating a one-match sample as reliable player intelligence.
create or replace view public.fixture_player_outlook
with (security_invoker = true)
as
select
  fl.fixture_id as "fixtureId",
  fl.team_id as "teamId",
  t.name as "teamName",
  p.id as "playerId",
  p.name,
  coalesce(fl.position,p.position) as position,
  fl.is_starting as "isStarting",
  greatest(coalesce(form.matches,0),coalesce(cache.matches_sample,0)) as "matchesSample",
  case when greatest(coalesce(form.matches,0),coalesce(cache.matches_sample,0)) < 5 then null
       when coalesce(cache.matches_sample,0) > coalesce(form.matches,0) then cache.avg_minutes else form.avg_minutes end as "avgMinutes",
  case when greatest(coalesce(form.matches,0),coalesce(cache.matches_sample,0)) < 5 then null
       when coalesce(cache.matches_sample,0) > coalesce(form.matches,0) then cache.avg_shots else form.avg_shots end as "avgShots",
  case when greatest(coalesce(form.matches,0),coalesce(cache.matches_sample,0)) < 5 then null
       when coalesce(cache.matches_sample,0) > coalesce(form.matches,0) then cache.avg_shots_on_target else form.avg_sot end as "avgShotsOnTarget",
  case when greatest(coalesce(form.matches,0),coalesce(cache.matches_sample,0)) < 5 then null
       when coalesce(cache.matches_sample,0) > coalesce(form.matches,0) then cache.avg_goals else form.avg_goals end as "avgGoals",
  case when greatest(coalesce(form.matches,0),coalesce(cache.matches_sample,0)) < 5 then null
       when coalesce(cache.matches_sample,0) > coalesce(form.matches,0) then cache.avg_yellow_cards else form.avg_cards end as "avgYellowCards"
from public.fixture_lineups fl
join public.fixtures current_fixture on current_fixture.id = fl.fixture_id
join public.players p on p.id = fl.player_id
join public.teams t on t.id = fl.team_id
left join lateral (
  select
    count(*)::integer as matches,
    round(avg(x.minutes)::numeric,1) as avg_minutes,
    round(avg(x.shots)::numeric,2) as avg_shots,
    round(avg(x.shots_on_target)::numeric,2) as avg_sot,
    round(avg(x.goals)::numeric,2) as avg_goals,
    round(avg(x.yellow_cards)::numeric,2) as avg_cards
  from (
    select pms.*
    from public.player_match_stats pms
    join public.fixtures pf on pf.id = pms.fixture_id
    where pms.player_id = p.id
      and pf.kickoff < current_fixture.kickoff
      and pf.status = 'finished'
    order by pf.kickoff desc
    limit 10
  ) x
) form on true
left join public.fixture_player_form_cache cache
  on cache.fixture_id = fl.fixture_id and cache.player_id = fl.player_id
where fl.is_starting = true;

grant select on public.fixture_player_outlook to anon, authenticated;

commit;

select 'EVE Player Form Cache V1 patch complete' as status;
