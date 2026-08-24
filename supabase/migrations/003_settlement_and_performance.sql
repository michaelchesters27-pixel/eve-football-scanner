-- EVE Football Scanner v0 settlement + transparent performance views

create or replace function public.settle_v0_predictions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer := 0;
begin
  insert into public.prediction_results (prediction_id, outcome, settled_at)
  select
    p.id,
    case
      when fs.selection_key = 'home_cards_1_5' then case when coalesce(hs.yellow_cards, -1) >= 2 then 'win' else 'loss' end
      when fs.selection_key = 'away_cards_1_5' then case when coalesce(aw.yellow_cards, -1) >= 2 then 'win' else 'loss' end
      when fs.selection_key = 'home_corners_4_5' then case when coalesce(hs.corners, -1) >= 5 then 'win' else 'loss' end
      when fs.selection_key = 'away_corners_4_5' then case when coalesce(aw.corners, -1) >= 5 then 'win' else 'loss' end
      when fs.selection_key = 'over_1_5' then case when coalesce(f.home_goals, 0) + coalesce(f.away_goals, 0) >= 2 then 'win' else 'loss' end
      when fs.selection_key = 'second_half_0_5' then case
        when (coalesce(f.home_goals, 0) + coalesce(f.away_goals, 0))
           - (coalesce(f.half_time_home_goals, 0) + coalesce(f.half_time_away_goals, 0)) >= 1 then 'win'
        else 'loss'
      end
      else 'void'
    end,
    now()
  from public.predictions p
  join public.feature_snapshots fs on fs.id = p.feature_snapshot_id
  join public.fixtures f on f.id = p.fixture_id and f.status = 'finished'
  left join public.team_match_stats hs on hs.fixture_id = f.id and hs.team_id = f.home_team_id
  left join public.team_match_stats aw on aw.fixture_id = f.id and aw.team_id = f.away_team_id
  left join public.prediction_results existing on existing.prediction_id = p.id
  where existing.prediction_id is null
    and p.model_version = 'v0-research';

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.settle_v0_predictions() from public;
revoke all on function public.settle_v0_predictions() from anon;
revoke all on function public.settle_v0_predictions() from authenticated;

create or replace view public.scanner_performance
with (security_invoker = true)
as
select
  p.market,
  p.grade,
  p.model_version,
  count(*) filter (where r.outcome in ('win','loss'))::integer as settled,
  count(*) filter (where r.outcome = 'win')::integer as wins,
  count(*) filter (where r.outcome = 'loss')::integer as losses,
  case
    when count(*) filter (where r.outcome in ('win','loss')) = 0 then null
    else round(
      100.0 * count(*) filter (where r.outcome = 'win')
      / count(*) filter (where r.outcome in ('win','loss')),
      1
    )
  end as hit_rate
from public.predictions p
join public.prediction_results r on r.prediction_id = p.id
where p.publish_status = 'published'
group by p.market, p.grade, p.model_version
order by p.market, p.grade;

create policy "public read published prediction results"
on public.prediction_results
for select
to anon, authenticated
using (
  exists (
    select 1 from public.predictions p
    where p.id = prediction_results.prediction_id
      and p.publish_status = 'published'
  )
);

comment on function public.settle_v0_predictions() is 'Settles v0 card/corner/goal selections from completed fixture statistics. No price-based P/L is calculated until odds are recorded.';
comment on view public.scanner_performance is 'Public hit-rate summary for published EVE selections. ROI is intentionally excluded until taken odds are captured.';
