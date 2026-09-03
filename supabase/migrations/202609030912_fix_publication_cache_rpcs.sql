-- Production repair: make publication-cache replacement transactional and safe-update compatible.

create or replace function public.refresh_scanner_best_bets_cache()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_count_value integer;
  refreshed timestamptz := clock_timestamp();
begin
  truncate table public.scanner_best_bets_public_cache;

  insert into public.scanner_best_bets_public_cache
  select r.*, refreshed
  from public.scanner_best_bets_raw r
  join public.predictions p on p.id = r.id
  where r."kickoffUtc" > now()
    and r."fairProbability" is not null
    and p.publish_status = 'published'
    and p.fair_probability is not null
    and p.generated_at >= now() - interval '2 hours';

  get diagnostics row_count_value = row_count;

  insert into public.scanner_publication_state(surface, refreshed_at, row_count)
  values ('best_bets', refreshed, row_count_value)
  on conflict (surface) do update
    set refreshed_at = excluded.refreshed_at,
        row_count = excluded.row_count;

  return jsonb_build_object('ok', true, 'surface', 'best_bets', 'rows', row_count_value, 'refreshedAt', refreshed);
end;
$$;

create or replace function public.refresh_scanner_market_lab_cache()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  row_count_value integer;
  refreshed timestamptz := clock_timestamp();
begin
  truncate table public.scanner_expanded_markets_public_cache;

  insert into public.scanner_expanded_markets_public_cache
  select r.*, refreshed
  from public.scanner_expanded_markets_raw r
  join public.predictions p on p.id = r.id
  where r."kickoffUtc" > now()
    and r."fairProbability" is not null
    and p.publish_status = 'published'
    and p.fair_probability is not null
    and p.generated_at >= now() - interval '2 hours';

  get diagnostics row_count_value = row_count;

  insert into public.scanner_publication_state(surface, refreshed_at, row_count)
  values ('market_lab', refreshed, row_count_value)
  on conflict (surface) do update
    set refreshed_at = excluded.refreshed_at,
        row_count = excluded.row_count;

  return jsonb_build_object('ok', true, 'surface', 'market_lab', 'rows', row_count_value, 'refreshedAt', refreshed);
end;
$$;

revoke all on function public.refresh_scanner_best_bets_cache() from public, anon, authenticated;
revoke all on function public.refresh_scanner_market_lab_cache() from public, anon, authenticated;
grant execute on function public.refresh_scanner_best_bets_cache() to service_role;
grant execute on function public.refresh_scanner_market_lab_cache() to service_role;
