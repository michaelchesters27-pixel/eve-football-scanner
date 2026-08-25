import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '49 5 * * *' }

type Market = 'btts' | 'team_goals' | 'half_goals' | 'match_cards' | 'match_corners'
type Grade = 'A+' | 'A' | 'B' | 'C'
type Prediction = {
  id: string
  market: Market
  confidence: number
  data_quality: number
  feature_snapshots?: { features?: any } | null
}
type Recommendation = { threshold: number; n: number; wins: number; hitRate: number; wilsonLow: number }

const MODEL = 'v1-expanded-research'
const BACKTEST_JOB = 'backtest-2526-v1-expanded'

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function chunks<T>(items: T[], size = 100) {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
function gradeFor(score: number, threshold: number): Grade {
  if (score >= threshold + 8) return 'A+'
  if (score >= threshold) return 'A'
  if (score >= Math.max(60, threshold - 8)) return 'B'
  return 'C'
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: runs, error: runError } = await supabase
    .from('source_sync_runs')
    .select('id,finished_at,status,error_message')
    .eq('job_name', BACKTEST_JOB)
    .eq('status', 'success')
    .order('finished_at', { ascending: false })
    .limit(1)
  if (runError) return new Response(JSON.stringify({ ok: false, error: runError.message }), { status: 500, headers: { 'content-type': 'application/json' } })
  const latest = runs?.[0]
  if (!latest?.error_message) {
    return new Response(JSON.stringify({ ok: false, calibrationReady: false, message: 'Run the expanded walk-forward backtest first.' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  let summary: any
  try { summary = JSON.parse(latest.error_message) } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Latest expanded backtest summary could not be parsed.' }), { status: 500, headers: { 'content-type': 'application/json' } })
  }

  const recommendations = summary.recommendedThresholds as Partial<Record<Market, Recommendation>>
  const markets = Object.keys(recommendations).filter((m) => recommendations[m as Market]) as Market[]
  if (!markets.length) {
    return new Response(JSON.stringify({ ok: false, calibrationReady: false, message: 'Backtest completed but produced no usable market thresholds.' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('predictions')
    .select('id,market,confidence,data_quality,feature_snapshots(features),fixtures!inner(kickoff,status)')
    .eq('model_version', MODEL)
    .in('fixtures.status', ['scheduled', 'live'])
    .gte('fixtures.kickoff', now)
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'content-type': 'application/json' } })

  const rows = (data ?? []) as unknown as Prediction[]
  const counts: Record<string, { evaluated: number; published: number; threshold: number; fairProbability: number; xiDowngrades:number; xiPromotionsBlocked:number }> = {}
  const groups = new Map<string, { ids: string[]; grade: Grade; publish_status: 'published' | 'suppressed'; fair_probability: number | null }>()

  for (const row of rows) {
    const recommendation = recommendations[row.market]
    if (!recommendation) continue
    const threshold = Number(recommendation.threshold)
    const fair = Math.max(0, Math.min(0.99, Number(recommendation.wilsonLow) / 100))
    const baselineRaw=Number(row.feature_snapshots?.features?.lineupImpact?.baselineConfidence)
    const baselineConfidence=Number.isFinite(baselineRaw)?baselineRaw:row.confidence
    const baselinePass=baselineConfidence>=threshold
    const refinedPass=row.confidence>=threshold
    // XI intelligence can veto/downgrade a calibrated candidate, but cannot create
    // a new qualifier that the lineup-neutral walk-forward model did not already pass.
    const publish = row.data_quality >= 70 && baselinePass && refinedPass
    const grade = gradeFor(row.confidence, threshold)
    counts[row.market] ??= { evaluated: 0, published: 0, threshold, fairProbability: fair, xiDowngrades:0, xiPromotionsBlocked:0 }
    counts[row.market].evaluated += 1
    if (publish) counts[row.market].published += 1
    if(baselinePass&&!refinedPass) counts[row.market].xiDowngrades+=1
    if(!baselinePass&&refinedPass) counts[row.market].xiPromotionsBlocked+=1

    const publish_status = publish ? 'published' : 'suppressed'
    const fair_probability = publish ? fair : null
    const key = `${row.market}|${grade}|${publish_status}|${fair_probability ?? 'null'}`
    const group = groups.get(key) ?? { ids: [], grade, publish_status, fair_probability }
    group.ids.push(row.id)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    for (const ids of chunks(group.ids)) {
      const { error: updateError } = await supabase
        .from('predictions')
        .update({ grade: group.grade, publish_status: group.publish_status, fair_probability: group.fair_probability })
        .in('id', ids)
      if (updateError) throw updateError
    }
  }

  const totalPublished = Object.values(counts).reduce((sum, x) => sum + x.published, 0)
  return new Response(JSON.stringify({
    ok: true,
    calibrationReady: true,
    model: MODEL,
    calibrationSeason: summary.calibrationSeason,
    outOfSampleSeason: summary.outOfSampleSeason,
    backtestFinishedAt: latest.finished_at,
    counts,
    totalEvaluated: rows.length,
    totalPublished,
    lineupGuardrail:'Confirmed XI intelligence may downgrade/veto a calibrated candidate, but it cannot promote a candidate that failed the lineup-neutral walk-forward threshold.',
    note: 'Expanded markets are hit-rate calibrated from 2025/26 walk-forward data. Fair probability uses the conservative 95% Wilson lower bound. They remain in Market Lab during 2026/27 out-of-sample validation and are not automatically promoted to Best Bets.',
  }), { headers: { 'content-type': 'application/json' } })
}
