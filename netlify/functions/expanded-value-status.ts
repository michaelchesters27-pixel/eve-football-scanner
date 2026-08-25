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

  const [{ data, error }, { data: latestRun, error: runError }] = await Promise.all([
    supabase
      .from('scanner_expanded_markets')
      .select('market,selection,homeTeam,awayTeam,kickoff,confidence,dataQuality,fairProbability,fairOdds,bestBookmaker,bestOdds,edgePct,expectedValuePct,valueStatus')
      .order('confidence', { ascending: false })
      .limit(100),
    supabase
      .from('source_sync_runs')
      .select('started_at,finished_at,status,rows_upserted,error_message')
      .eq('job_name', 'expanded-value-engine')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  if (error) {
    return new Response(JSON.stringify({
      ok: false,
      patchRequired: true,
      error: error.message,
      message: 'Run supabase/PATCH_EXPANDED_VALUE_V1.sql once, then retry.',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const rows = data ?? []
  const counts = rows.reduce((acc: Record<string, number>, row: any) => {
    const key = row.valueStatus ?? 'unknown'
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const priced = rows.filter((r: any) => r.bestOdds != null)
  const values = rows.filter((r: any) => r.valueStatus === 'value' || r.valueStatus === 'strong')
  const coveragePct = rows.length ? Math.round(priced.length / rows.length * 1000) / 10 : 0

  return new Response(JSON.stringify({
    ok: true,
    expandedSignals: rows.length,
    pricedSignals: priced.length,
    pricingCoveragePct: coveragePct,
    valueCounts: counts,
    values: values.slice(0, 20),
    latestPriced: priced.slice(0, 20),
    latestPricingRun: runError ? { error: runError.message } : latestRun ?? null,
    automaticRefresh: {
      schedule: 'hourly',
      horizon: 'next 48 hours',
      priority: 'nearest calibrated fixtures first',
      policy: {
        '0-3h before kickoff': 'check every hour',
        '3-8h': 'check every 2 hours',
        '8-24h': 'check every 4 hours',
        '24-48h': 'check every 8 hours',
      },
      quotaProtection: 'maximum 4 fixtures per run; stops early when Odds API remaining credits fall to 20 or less',
    },
    rule: 'VALUE requires >=5pp probability edge and >=5% EV; STRONG VALUE requires >=7pp and >=10% EV.',
    note: 'NO VALUE means skip at the current bookmaker price. WAITING means EVE has not found a compatible recent price yet; it will automatically retry more often as kickoff approaches.',
  }), { headers: { 'content-type': 'application/json' } })
}
