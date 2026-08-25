import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '50 5 * * *' }

type HistRow = {
  fixture_id: string
  kickoff: string
  team_id: string
  venue: 'home' | 'away'
  goals: number | null
  opponent_goals: number | null
  yellow_cards: number | null
  opponent_yellow_cards: number | null
  corners: number | null
  opponent_corners: number | null
  home_goals: number | null
  away_goals: number | null
  half_time_home_goals: number | null
  half_time_away_goals: number | null
}

type Signal = {
  id: string
  selection: string
  confidence: number
  data_quality: number
  model_version: string
  feature_snapshots: { selection_key: string } | null
}

const MODEL = 'v1-combo-research'
const SUPPORTED_KEYS = new Set(['over_1_5','second_half_0_5','btts_yes','first_half_0_5','match_cards_3_5','match_corners_8_5'])

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function pct(n: number, d: number) { return d ? Math.round((n / d) * 1000) / 10 : 0 }
function totalGoals(r: HistRow) { return (r.home_goals ?? 0) + (r.away_goals ?? 0) }
function firstHalfGoals(r: HistRow) { return (r.half_time_home_goals ?? 0) + (r.half_time_away_goals ?? 0) }
function secondHalfGoals(r: HistRow) { return totalGoals(r) - firstHalfGoals(r) }
function totalCards(r: HistRow) { return (r.yellow_cards ?? 0) + (r.opponent_yellow_cards ?? 0) }
function totalCorners(r: HistRow) { return (r.corners ?? 0) + (r.opponent_corners ?? 0) }
function hit(key: string, r: HistRow) {
  if (key === 'over_1_5') return totalGoals(r) >= 2
  if (key === 'second_half_0_5') return secondHalfGoals(r) >= 1
  if (key === 'btts_yes') return (r.goals ?? 0) > 0 && (r.opponent_goals ?? 0) > 0
  if (key === 'first_half_0_5') return firstHalfGoals(r) >= 1
  if (key === 'match_cards_3_5') return totalCards(r) >= 4
  if (key === 'match_corners_8_5') return totalCorners(r) >= 9
  return false
}
function label(key: string) {
  const labels: Record<string, string> = {
    over_1_5: 'Over 1.5 Goals',
    second_half_0_5: 'Second Half Over 0.5 Goals',
    btts_yes: 'Both Teams To Score',
    first_half_0_5: 'First Half Over 0.5 Goals',
    match_cards_3_5: '4+ Yellow Cards',
    match_corners_8_5: '9+ Corners',
  }
  return labels[key] ?? key
}

export default async (request?: Request) => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
  const now = new Date()
  const horizon = new Date(now.getTime() + 7 * 86400000)
  const requestedFixtureId = request ? new URL(request.url).searchParams.get('fixture_id') : null

  let fixtureQuery = supabase
    .from('fixtures')
    .select('id,kickoff,home_team_id,away_team_id')
    .in('status',['scheduled','live'])
    .gte('kickoff', now.toISOString())
    .lt('kickoff', horizon.toISOString())
    .order('kickoff')
  if (requestedFixtureId) fixtureQuery = fixtureQuery.eq('id', requestedFixtureId)
  const { data: fixtures, error: fixtureError } = await fixtureQuery
  if (fixtureError) return new Response(JSON.stringify({ ok: false, error: fixtureError.message }), { status: 500, headers: { 'content-type': 'application/json' } })

  let written = 0
  const summaries: any[] = []

  for (const fixture of fixtures ?? []) {
    const { data: signalRows, error: signalError } = await supabase
      .from('predictions')
      .select('id,selection,confidence,data_quality,model_version,feature_snapshots(selection_key)')
      .eq('fixture_id', fixture.id)
      .eq('publish_status','published')
      .in('model_version',['v0-research','v1-expanded-research'])
      .order('confidence',{ ascending:false })
    if (signalError) continue

    const signals = ((signalRows ?? []) as unknown as Signal[])
      .filter((s) => SUPPORTED_KEYS.has(s.feature_snapshots?.selection_key ?? ''))
      .sort((a,b) => b.confidence - a.confidence)

    const distinct: Signal[] = []
    const seen = new Set<string>()
    for (const signal of signals) {
      const key = signal.feature_snapshots?.selection_key ?? ''
      if (seen.has(key)) continue
      seen.add(key)
      distinct.push(signal)
      if (distinct.length === 3) break
    }
    if (distinct.length < 2) continue

    const { data: histRows, error: histError } = await supabase
      .from('team_match_flat')
      .select('*')
      .in('team_id',[fixture.home_team_id, fixture.away_team_id])
      .lt('kickoff', fixture.kickoff)
      .order('kickoff',{ ascending:false })
      .limit(220)
    if (histError) continue

    const allHistory = (histRows ?? []) as HistRow[]
    const homeVenue = allHistory.filter((r) => r.team_id === fixture.home_team_id && r.venue === 'home').slice(0,20)
    const awayVenue = allHistory.filter((r) => r.team_id === fixture.away_team_id && r.venue === 'away').slice(0,20)
    const dedupe = new Map<string,HistRow>()
    for (const row of [...homeVenue,...awayVenue]) dedupe.set(row.fixture_id,row)
    const sample = [...dedupe.values()]
    if (sample.length < 10) continue

    const legs = distinct.map((s) => ({
      key: s.feature_snapshots?.selection_key ?? '',
      selection: s.selection || label(s.feature_snapshots?.selection_key ?? ''),
      eveScore: s.confidence,
      dataQuality: s.data_quality,
    }))

    const singles = legs.map((leg) => {
      const hits = sample.filter((r) => hit(leg.key,r)).length
      return { ...leg, probability: pct(hits,sample.length), hits, sample: sample.length }
    })

    const doubles: any[] = []
    for (let i=0;i<legs.length;i+=1) {
      for (let j=i+1;j<legs.length;j+=1) {
        const hits = sample.filter((r) => hit(legs[i].key,r) && hit(legs[j].key,r)).length
        doubles.push({
          legs: [legs[i].selection,legs[j].selection],
          keys: [legs[i].key,legs[j].key],
          probability: pct(hits,sample.length),
          hits,
          sample: sample.length,
        })
      }
    }
    doubles.sort((a,b) => b.probability - a.probability)

    let treble: any = null
    if (legs.length >= 3) {
      const hits = sample.filter((r) => legs.every((leg) => hit(leg.key,r))).length
      treble = {
        legs: legs.map((l) => l.selection),
        keys: legs.map((l) => l.key),
        probability: pct(hits,sample.length),
        hits,
        sample: sample.length,
      }
    }

    const dataQuality = Math.min(100,Math.round(sample.length / 30 * 100))
    const explanation = `Joint probabilities use ${sample.length} comparable historical home/away matches. Doubles and trebles are measured as actual joint hit frequencies; EVE does not multiply single-leg percentages.`
    const { error: writeError } = await supabase.from('combo_recommendations').upsert({
      fixture_id: fixture.id,
      model_version: MODEL,
      sample_size: sample.length,
      singles,
      doubles,
      treble,
      explanation,
      data_quality: dataQuality,
      calculated_at: new Date().toISOString(),
    }, { onConflict:'fixture_id,model_version' })
    if (!writeError) {
      written += 1
      summaries.push({ fixtureId: fixture.id, sample: sample.length, singles: singles.map((s) => [s.selection,s.probability]), bestDouble: doubles[0]?.probability ?? null, treble: treble?.probability ?? null })
    }
  }

  return new Response(JSON.stringify({ ok:true, model:MODEL, fixtures:fixtures?.length ?? 0, written, summaries, note:'Research probabilities, not bookmaker value. Joint rates are empirical rather than multiplied.' }), { headers:{ 'content-type':'application/json' } })
}
