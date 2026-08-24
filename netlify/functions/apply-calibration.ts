import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

export const config = { schedule: '40 5 * * *' }

type Market = 'cards' | 'corners' | 'goals'
type Grade = 'A+' | 'A' | 'B' | 'C'

type PredictionRow = {
  id: string
  market: Market
  confidence: number
  data_quality: number
}

const MODEL = 'v0-research'

// 2025/26 walk-forward calibration. These are score gates, NOT claimed
// probabilities or bookmaker edges. Revisit after out-of-sample 2026/27 data.
const publishThreshold: Record<Market, number> = {
  cards: 70,   // 616 selections, 69.3% hit, Wilson low 65.6%
  corners: 82, // 50 selections, 80.0% hit, Wilson low 67.0%
  goals: 90,   // 302 selections, 85.1% hit, Wilson low 80.6%
}

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function calibratedGrade(market: Market, score: number): Grade {
  if (market === 'cards') {
    if (score >= 78) return 'A+'
    if (score >= 70) return 'A'
    if (score >= 60) return 'B'
    return 'C'
  }
  if (market === 'corners') {
    if (score >= 82) return 'A+'
    if (score >= 78) return 'A'
    if (score >= 70) return 'B'
    return 'C'
  }
  if (score >= 90) return 'A+'
  if (score >= 88) return 'A'
  if (score >= 80) return 'B'
  return 'C'
}

function chunks<T>(items: T[], size = 100) {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as any },
  })

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('predictions')
    .select('id,market,confidence,data_quality,fixtures!inner(kickoff,status)')
    .eq('model_version', MODEL)
    .in('fixtures.status', ['scheduled', 'live'])
    .gte('fixtures.kickoff', now)

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  const rows = (data ?? []) as unknown as PredictionRow[]
  const groups = new Map<string, { grade: Grade; publish_status: 'published' | 'suppressed'; ids: string[] }>()
  const counts: Record<Market, { evaluated: number; published: number }> = {
    cards: { evaluated: 0, published: 0 },
    corners: { evaluated: 0, published: 0 },
    goals: { evaluated: 0, published: 0 },
  }

  for (const row of rows) {
    const market = row.market
    counts[market].evaluated += 1
    const publish = row.confidence >= publishThreshold[market] && row.data_quality >= 70
    if (publish) counts[market].published += 1
    const grade = calibratedGrade(market, row.confidence)
    const publish_status = publish ? 'published' : 'suppressed'
    const key = `${grade}|${publish_status}`
    const group = groups.get(key) ?? { grade, publish_status, ids: [] }
    group.ids.push(row.id)
    groups.set(key, group)
  }

  for (const group of groups.values()) {
    for (const ids of chunks(group.ids)) {
      const { error: updateError } = await supabase
        .from('predictions')
        .update({ grade: group.grade, publish_status: group.publish_status })
        .in('id', ids)
      if (updateError) throw updateError
    }
  }

  const totalPublished = Object.values(counts).reduce((sum, x) => sum + x.published, 0)
  return new Response(JSON.stringify({
    ok: true,
    model: MODEL,
    thresholds: publishThreshold,
    counts,
    totalEvaluated: rows.length,
    totalPublished,
    note: 'Walk-forward hit-rate calibration only; bookmaker-value edge is not yet established.',
  }), { headers: { 'content-type': 'application/json' } })
}
