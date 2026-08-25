import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '25 5 * * *' }

type Prediction = {
  id: string
  model_version: string
  feature_snapshots: { selection_key: string } | null
  fixtures: {
    id: string
    kickoff: string
    home_team_id: string
    away_team_id: string
    home_goals: number | null
    away_goals: number | null
    half_time_home_goals: number | null
    half_time_away_goals: number | null
  }
}

type FixtureStats = {
  id: string
  home_goals: number | null
  away_goals: number | null
  half_time_home_goals: number | null
  half_time_away_goals: number | null
  homeCards: number | null
  awayCards: number | null
  homeCorners: number | null
  awayCorners: number | null
}

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function outcome(key: string, s: FixtureStats): 'win' | 'loss' | 'void' {
  const hg = Number(s.home_goals ?? 0)
  const ag = Number(s.away_goals ?? 0)
  const hth = Number(s.half_time_home_goals ?? 0)
  const hta = Number(s.half_time_away_goals ?? 0)
  const hc = Number(s.homeCards ?? -1)
  const ac = Number(s.awayCards ?? -1)
  const hco = Number(s.homeCorners ?? -1)
  const aco = Number(s.awayCorners ?? -1)

  if (key === 'home_cards_1_5') return hc < 0 ? 'void' : hc >= 2 ? 'win' : 'loss'
  if (key === 'away_cards_1_5') return ac < 0 ? 'void' : ac >= 2 ? 'win' : 'loss'
  if (key === 'home_corners_4_5') return hco < 0 ? 'void' : hco >= 5 ? 'win' : 'loss'
  if (key === 'away_corners_4_5') return aco < 0 ? 'void' : aco >= 5 ? 'win' : 'loss'
  if (key === 'over_1_5') return hg + ag >= 2 ? 'win' : 'loss'
  if (key === 'second_half_0_5') return (hg + ag) - (hth + hta) >= 1 ? 'win' : 'loss'
  if (key === 'btts_yes') return hg > 0 && ag > 0 ? 'win' : 'loss'
  if (key === 'home_goals_0_5') return hg >= 1 ? 'win' : 'loss'
  if (key === 'away_goals_0_5') return ag >= 1 ? 'win' : 'loss'
  if (key === 'home_goals_1_5') return hg >= 2 ? 'win' : 'loss'
  if (key === 'away_goals_1_5') return ag >= 2 ? 'win' : 'loss'
  if (key === 'first_half_0_5') return hth + hta >= 1 ? 'win' : 'loss'
  if (key === 'match_cards_3_5') return hc < 0 || ac < 0 ? 'void' : hc + ac >= 4 ? 'win' : 'loss'
  if (key === 'match_corners_8_5') return hco < 0 || aco < 0 ? 'void' : hco + aco >= 9 ? 'win' : 'loss'
  return 'void'
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: predictionRows, error: predictionError } = await supabase
    .from('predictions')
    .select(`id,model_version,feature_snapshots(selection_key),fixtures!inner(id,kickoff,status,home_team_id,away_team_id,home_goals,away_goals,half_time_home_goals,half_time_away_goals)`)
    .in('model_version', ['v0-research', 'v1-expanded-research'])
    .eq('fixtures.status', 'finished')
    .order('generated_at', { ascending: true })
    .limit(1000)

  if (predictionError) {
    return new Response(JSON.stringify({ ok: false, error: predictionError.message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }

  const predictions = (predictionRows ?? []) as unknown as Prediction[]
  if (!predictions.length) return new Response(JSON.stringify({ ok: true, settled: 0, voided: 0, candidates: 0 }), { headers: { 'content-type': 'application/json' } })

  const ids = predictions.map((p) => p.id)
  const { data: existingRows } = await supabase.from('prediction_results').select('prediction_id').in('prediction_id', ids)
  const existing = new Set((existingRows ?? []).map((r: any) => r.prediction_id))

  const fixtureCache = new Map<string, FixtureStats | null>()
  async function resolveStats(p: Prediction): Promise<FixtureStats | null> {
    const f = p.fixtures
    if (fixtureCache.has(f.id)) return fixtureCache.get(f.id) ?? null

    const start = new Date(Date.parse(f.kickoff) - 12 * 3600000).toISOString()
    const end = new Date(Date.parse(f.kickoff) + 12 * 3600000).toISOString()
    const { data: candidates, error } = await supabase
      .from('fixtures')
      .select('id,kickoff,home_goals,away_goals,half_time_home_goals,half_time_away_goals')
      .eq('status', 'finished')
      .eq('home_team_id', f.home_team_id)
      .eq('away_team_id', f.away_team_id)
      .gte('kickoff', start)
      .lte('kickoff', end)
    if (error) { fixtureCache.set(f.id, null); return null }

    const ordered = [...(candidates ?? [])].sort((a: any, b: any) => {
      if (a.id === f.id) return -1
      if (b.id === f.id) return 1
      return Math.abs(Date.parse(a.kickoff) - Date.parse(f.kickoff)) - Math.abs(Date.parse(b.kickoff) - Date.parse(f.kickoff))
    })

    for (const candidate of ordered) {
      const { data: stats } = await supabase
        .from('team_match_stats')
        .select('team_id,yellow_cards,corners')
        .eq('fixture_id', candidate.id)
        .in('team_id', [f.home_team_id, f.away_team_id])
      const home = (stats ?? []).find((r: any) => r.team_id === f.home_team_id)
      const away = (stats ?? []).find((r: any) => r.team_id === f.away_team_id)
      const resolved: FixtureStats = {
        id: candidate.id,
        home_goals: candidate.home_goals ?? f.home_goals,
        away_goals: candidate.away_goals ?? f.away_goals,
        half_time_home_goals: candidate.half_time_home_goals ?? f.half_time_home_goals,
        half_time_away_goals: candidate.half_time_away_goals ?? f.half_time_away_goals,
        homeCards: home?.yellow_cards ?? null,
        awayCards: away?.yellow_cards ?? null,
        homeCorners: home?.corners ?? null,
        awayCorners: away?.corners ?? null,
      }
      if (candidate.id === f.id || home || away) { fixtureCache.set(f.id, resolved); return resolved }
    }

    // Goals can still be settled from FotMob even if the detailed stats source has not landed yet.
    if (f.home_goals != null && f.away_goals != null) {
      const fallback: FixtureStats = { id: f.id, home_goals: f.home_goals, away_goals: f.away_goals, half_time_home_goals: f.half_time_home_goals, half_time_away_goals: f.half_time_away_goals, homeCards: null, awayCards: null, homeCorners: null, awayCorners: null }
      fixtureCache.set(f.id, fallback)
      return fallback
    }
    fixtureCache.set(f.id, null)
    return null
  }

  const inserts: any[] = []
  let voided = 0
  for (const prediction of predictions) {
    if (existing.has(prediction.id)) continue
    const key = prediction.feature_snapshots?.selection_key ?? ''
    const stats = await resolveStats(prediction)
    if (!stats) continue
    const result = outcome(key, stats)
    if (result === 'void') voided += 1
    inserts.push({ prediction_id: prediction.id, outcome: result, settled_at: new Date().toISOString(), notes: stats.id === prediction.fixtures.id ? 'Settled from primary fixture' : `Settled from matched stats fixture ${stats.id}` })
  }

  if (inserts.length) {
    const { error } = await supabase.from('prediction_results').upsert(inserts, { onConflict: 'prediction_id' })
    if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }

  return new Response(JSON.stringify({ ok: true, candidates: predictions.length, settled: inserts.length, voided, matchedFixtures: fixtureCache.size }), {
    headers: { 'content-type': 'application/json' },
  })
}
