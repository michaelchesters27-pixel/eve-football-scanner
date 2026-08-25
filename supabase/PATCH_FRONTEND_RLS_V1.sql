-- EVE Football Scanner — FRONTEND RLS PATCH V1
-- Run ONCE in the dedicated FREE eve-football-scanner Supabase project.
-- Fixes the public frontend seeing 0 expanded signals while service-role status endpoints can see them.
-- Cause: scanner_expanded_markets is SECURITY INVOKER and joins feature_snapshots;
-- feature_snapshots had RLS enabled but no anon/authenticated SELECT policy.

begin;

-- Allow the public frontend to read feature snapshots ONLY when they belong to
-- a prediction that is itself published. Suppressed/draft research stays hidden.
do $$
begin
  create policy "public read published feature snapshots"
  on public.feature_snapshots
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.predictions p
      where p.feature_snapshot_id = feature_snapshots.id
        and p.publish_status = 'published'
    )
  );
exception when duplicate_object then null;
end $$;

-- Value views also read odds_snapshots. Keep odds public only for published
-- predictions so Market Lab / Best Bets can show WAITING / NO VALUE / VALUE.
do $$
begin
  create policy "public read published odds snapshots"
  on public.odds_snapshots
  for select
  to anon, authenticated
  using (
    exists (
      select 1
      from public.predictions p
      where p.id = odds_snapshots.prediction_id
        and p.publish_status = 'published'
    )
  );
exception when duplicate_object then null;
end $$;

-- Explicit grants are harmless if already present and make the intended
-- frontend contract clear.
grant select on public.feature_snapshots to anon, authenticated;
grant select on public.odds_snapshots to anon, authenticated;
grant select on public.scanner_expanded_markets to anon, authenticated;
grant select on public.scanner_best_bets to anon, authenticated;

commit;

select 'EVE Frontend RLS V1 patch complete' as status;
