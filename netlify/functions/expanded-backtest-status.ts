import { createClient } from '@supabase/supabase-js'

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: runs, error: runError } = await supabase
    .from('source_sync_runs')
    .select('id,started_at,finished_at,status,rows_upserted,error_message')
    .eq('job_name', 'backtest-2526-v1-expanded')
    .order('started_at', { ascending: false })
    .limit(1)
  if (runError) return new Response(JSON.stringify({ ok: false, error: runError.message }), { status: 500, headers: { 'content-type': 'application/json' } })

  const run = runs?.[0] ?? null
  let summary: any = null
  if (run?.status === 'success' && run.error_message) {
    try { summary = JSON.parse(run.error_message) } catch { summary = null }
  }

  const now = new Date().toISOString()
  const { data: liveRows, error: liveError } = await supabase
    .from('predictions')
    .select('market,publish_status,fair_probability,confidence,data_quality,fixtures!inner(kickoff,status)')
    .eq('model_version', 'v1-expanded-research')
    .in('fixtures.status', ['scheduled', 'live'])
    .gte('fixtures.kickoff', now)
  if (liveError) return new Response(JSON.stringify({ ok: false, error: liveError.message }), { status: 500, headers: { 'content-type': 'application/json' } })

  const current: Record<string, { total: number; published: number; calibrated: number }> = {}
  for (const row of (liveRows ?? []) as any[]) {
    current[row.market] ??= { total: 0, published: 0, calibrated: 0 }
    current[row.market].total += 1
    if (row.publish_status === 'published') current[row.market].published += 1
    if (row.fair_probability != null) current[row.market].calibrated += 1
  }

  return new Response(JSON.stringify({
    ok: true,
    run: run ? {
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      evaluatedCandidates: run.rows_upserted,
    } : null,
    calibrationSeason: summary?.calibrationSeason ?? null,
    outOfSampleSeason: summary?.outOfSampleSeason ?? null,
    targetFixtures: summary?.targetFixtures ?? null,
    skippedLowHistory: summary?.skippedLowHistory ?? null,
    dataQuality70Plus: summary?.dataQuality70Plus ?? null,
    recommendedThresholds: summary?.recommendedThresholds ?? null,
    bySelection: summary?.bySelection ?? null,
    currentLiveSignals: current,
    methodology: summary?.methodology ?? null,
    caveat: summary?.caveat ?? (run?.status === 'running' ? 'Backtest is still running.' : null),
  }), { headers: { 'content-type': 'application/json' } })
}
