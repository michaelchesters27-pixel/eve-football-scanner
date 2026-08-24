import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as any },
  })

  const now = new Date().toISOString()
  const { data: predictions, error } = await supabase
    .from('predictions')
    .select(`id,market,selection,confidence,data_quality,fair_probability,
      fixtures!inner(kickoff,status,leagues(name,slug),home:teams!fixtures_home_team_id_fkey(name),away:teams!fixtures_away_team_id_fkey(name)),
      odds_snapshots(bookmaker,decimal_odds,captured_at)`)
    .eq('model_version', 'v0-research')
    .eq('publish_status', 'published')
    .in('fixtures.status', ['scheduled', 'live'])
    .gte('fixtures.kickoff', now)
    .order('confidence', { ascending: false })
    .limit(50)

  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'content-type': 'application/json' } })

  const eightHoursAgo = Date.now() - 8 * 3600000
  const rows = (predictions ?? []).map((p: any) => {
    const prices = (p.odds_snapshots ?? [])
      .filter((o: any) => Date.parse(o.captured_at) >= eightHoursAgo)
      .sort((a: any, b: any) => Number(b.decimal_odds) - Number(a.decimal_odds))
    const best = prices[0] ?? null
    const fair = p.fair_probability == null ? null : Number(p.fair_probability)
    const odds = best ? Number(best.decimal_odds) : null
    const implied = odds ? 1 / odds : null
    const edge = fair != null && implied != null ? fair - implied : null
    const ev = fair != null && odds != null ? fair * odds - 1 : null
    const valueStatus = fair == null ? 'uncalibrated'
      : odds == null ? 'waiting'
      : edge! >= 0.07 && ev! >= 0.10 ? 'strong'
      : edge! >= 0.05 && ev! >= 0.05 ? 'value'
      : 'no_value'
    return {
      id: p.id,
      match: `${p.fixtures?.home?.name ?? '?'} v ${p.fixtures?.away?.name ?? '?'}`,
      league: p.fixtures?.leagues?.name ?? null,
      kickoff: p.fixtures?.kickoff,
      market: p.market,
      selection: p.selection,
      eveScore: p.confidence,
      dataQuality: p.data_quality,
      fairProbabilityPct: fair == null ? null : Math.round(fair * 1000) / 10,
      fairOdds: fair ? Math.round((1 / fair) * 100) / 100 : null,
      bestBookmaker: best?.bookmaker ?? null,
      bestOdds: odds,
      impliedProbabilityPct: implied == null ? null : Math.round(implied * 1000) / 10,
      edgePct: edge == null ? null : Math.round(edge * 1000) / 10,
      expectedValuePct: ev == null ? null : Math.round(ev * 1000) / 10,
      valueStatus,
    }
  })

  const value = rows.filter((r) => r.valueStatus === 'value' || r.valueStatus === 'strong')
  return new Response(JSON.stringify({
    ok: true,
    liveSignals: rows.length,
    priced: rows.filter((r) => r.bestOdds != null).length,
    valueCount: value.length,
    value,
    all: rows,
    note: 'Fair probability is conservative walk-forward calibration. A value flag is not a guarantee of profit and remains subject to out-of-sample validation.',
  }), { headers: { 'content-type': 'application/json' } })
}
