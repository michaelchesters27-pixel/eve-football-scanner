import { createClient } from '@supabase/supabase-js'

type TargetMarket = 'half_goals' | 'match_cards' | 'match_corners'
type Evidence = { key?: string; label?: string; score?: number; display?: string; [key: string]: unknown }
type Row = {
  id: string
  market: TargetMarket
  confidence: number
  data_quality: number
  feature_snapshot_id: string | null
  feature_snapshots?: {
    id?: string
    evidence?: unknown
    features?: any
    data_quality?: number | null
  } | null
}

const MODEL = 'v1-expanded-research'
const JOB = 'expanded-math-correction-v2'
const MATH_VERSION = 'v2-selective-2025-26'
const CALIBRATION_JOB = 'backtest-2526-v1-expanded-v2'
const TARGET_MARKETS: TargetMarket[] = ['half_goals', 'match_cards', 'match_corners']

const WEIGHTS: Record<TargetMarket, Record<string, number>> = {
  half_goals: { recent: .22, venue: .30, opponent: .18, season: .17, h2h: .08, lineup: .05 },
  match_cards: { recent: .18, venue: .25, opponent: .15, season: .12, h2h: .07, referee: .18, lineup: .05 },
  match_corners: { recent: .22, venue: .32, opponent: .18, season: .18, h2h: .06, lineup: .04 },
}

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}
function gradeFor(score: number) {
  if (score >= 90) return 'A+'
  if (score >= 85) return 'A'
  if (score >= 75) return 'B'
  return 'C'
}
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
function evidenceArray(value: unknown): Evidence[] {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') as Evidence[] : []
}
function weightedScore(market: TargetMarket, evidence: Evidence[], quality: number, neutralLineup = false) {
  const weights = WEIGHTS[market]
  let total = 0
  let used = 0
  for (const item of evidence) {
    const key = String(item.key ?? '')
    if (!key || key === 'opponent') continue
    const weight = weights[key]
    if (!weight) continue
    const raw = neutralLineup && key === 'lineup' ? 50 : Number(item.score)
    if (!Number.isFinite(raw)) continue
    total += clamp(raw) * weight
    used += weight
  }
  const rawScore = used ? total / used : 0
  return Math.round(rawScore * (.88 + clamp(quality) / 100 * .12))
}
function correctedQuality(market: TargetMarket, oldQuality: number) {
  const old = clamp(Math.round(Number(oldQuality) || 0))
  if (market === 'match_cards') return old
  // The v1 non-card joint DQ formula contained an automatic fully-satisfied
  // 12% referee slot even though these markets do not use referee evidence.
  // Removing that slot changes the denominator from 100 to 88. Because v1 DQ
  // is stored as an integer, this reconstruction can differ from the original
  // unrounded components by at most one point; the independent walk-forward v2
  // backtest uses the exact component formula.
  return clamp(Math.round((Math.max(0, old - 12) / 88) * 100))
}
async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: run } = await supabase.from('source_sync_runs').insert({
    source: 'eve-expanded-model',
    job_name: JOB,
    status: 'running',
  }).select('id').single()

  try {
    // Fail closed unless the exact v2 walk-forward calibration exists.
    const { data: calibration, error: calibrationError } = await supabase
      .from('source_sync_runs')
      .select('id,finished_at,status')
      .eq('job_name', CALIBRATION_JOB)
      .eq('status', 'success')
      .order('finished_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (calibrationError) throw calibrationError
    if (!calibration) throw new Error(`Missing successful ${CALIBRATION_JOB} calibration`)

    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('predictions')
      .select('id,market,confidence,data_quality,feature_snapshot_id,feature_snapshots(id,evidence,features,data_quality),fixtures!inner(kickoff,status)')
      .eq('model_version', MODEL)
      .in('market', TARGET_MARKETS)
      .in('fixtures.status', ['scheduled', 'live'])
      .gte('fixtures.kickoff', now)
    if (error) throw error

    const rows = (data ?? []) as unknown as Row[]
    let corrected = 0
    let alreadyCorrected = 0
    let missingSnapshots = 0
    const marketCounts: Record<string, number> = {}

    await mapLimit(rows, 8, async (row) => {
      const snapshot = row.feature_snapshots
      const snapshotId = row.feature_snapshot_id ?? snapshot?.id ?? null
      if (!snapshotId) {
        missingSnapshots += 1
        throw new Error(`Prediction ${row.id} has no feature snapshot`)
      }

      const features = snapshot?.features && typeof snapshot.features === 'object' ? { ...snapshot.features } : {}
      if (features.mathVersion === MATH_VERSION) {
        alreadyCorrected += 1
        return
      }

      const rawEvidence = evidenceArray(snapshot?.evidence)
      if (!rawEvidence.length) throw new Error(`Feature snapshot ${snapshotId} has no evidence`)
      const opponentCount = rawEvidence.filter((item) => String(item.key ?? '') === 'opponent').length
      if (opponentCount !== 1) throw new Error(`Feature snapshot ${snapshotId} expected one duplicated opponent factor, found ${opponentCount}`)

      const evidence = rawEvidence
        .filter((item) => String(item.key ?? '') !== 'opponent')
        .map((item) => String(item.key ?? '') === 'season'
          ? { ...item, label: 'Trailing 30 matches' }
          : { ...item })

      const oldQuality = Number(row.data_quality ?? snapshot?.data_quality ?? 0)
      const dataQuality = correctedQuality(row.market, oldQuality)
      const refinedConfidence = weightedScore(row.market, evidence, dataQuality, false)
      const baselineConfidence = weightedScore(row.market, evidence, dataQuality, true)
      const previousImpact = features.lineupImpact && typeof features.lineupImpact === 'object' ? features.lineupImpact : {}
      const lineupImpact = {
        ...previousImpact,
        baselineConfidence,
        refinedConfidence,
        delta: refinedConfidence - baselineConfidence,
      }
      const mathCorrection = {
        version: MATH_VERSION,
        calibrationJob: CALIBRATION_JOB,
        removedDuplicateOpposition: true,
        removedFakeRefQualityCredit: row.market !== 'match_cards',
        priorConfidence: Number(row.confidence),
        correctedConfidence: refinedConfidence,
        priorDataQuality: oldQuality,
        correctedDataQuality: dataQuality,
      }
      const correctedFeatures = {
        ...features,
        lineupImpact,
        mathVersion: MATH_VERSION,
        mathCorrection,
        seasonLabel: 'Trailing 30 matches',
      }

      const { error: snapshotError } = await supabase
        .from('feature_snapshots')
        .update({ evidence, features: correctedFeatures, data_quality: dataQuality })
        .eq('id', snapshotId)
      if (snapshotError) throw snapshotError

      // Suppress while calibration is being recomputed. The calibrated publisher
      // is the only stage allowed to restore publication/fair probability.
      const { error: predictionError } = await supabase
        .from('predictions')
        .update({
          confidence: refinedConfidence,
          data_quality: dataQuality,
          grade: gradeFor(refinedConfidence),
          publish_status: 'suppressed',
          fair_probability: null,
        })
        .eq('id', row.id)
      if (predictionError) throw predictionError

      corrected += 1
      marketCounts[row.market] = (marketCounts[row.market] ?? 0) + 1
    })

    if (run?.id) {
      await supabase.from('source_sync_runs').update({
        finished_at: new Date().toISOString(),
        status: 'success',
        rows_upserted: corrected,
        error_message: JSON.stringify({
          mathVersion: MATH_VERSION,
          calibrationJob: CALIBRATION_JOB,
          evaluated: rows.length,
          corrected,
          alreadyCorrected,
          missingSnapshots,
          marketCounts,
        }),
      }).eq('id', run.id)
    }

    return json({
      ok: true,
      model: MODEL,
      mathVersion: MATH_VERSION,
      calibrationJob: CALIBRATION_JOB,
      evaluated: rows.length,
      corrected,
      alreadyCorrected,
      marketCounts,
      note: 'Only half-goals, match-cards and match-corners are corrected. BTTS and team-goals remain on their validated v1 maths.',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (run?.id) {
      await supabase.from('source_sync_runs').update({
        finished_at: new Date().toISOString(),
        status: 'failed',
        error_message: message.slice(0, 5000),
      }).eq('id', run.id)
    }
    return json({ ok: false, error: message }, 500)
  }
}
