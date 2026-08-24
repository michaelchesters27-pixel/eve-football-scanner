import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '35 5 * * *' }

type Market = 'cards' | 'corners' | 'goals'
type MatchRow = {
  fixture_id: string
  kickoff: string
  team_id: string
  opponent_team_id: string
  venue: 'home' | 'away'
  goals: number | null
  yellow_cards: number | null
  corners: number | null
  opponent_yellow_cards: number | null
  opponent_corners: number | null
  home_goals: number | null
  away_goals: number | null
  half_time_home_goals: number | null
  half_time_away_goals: number | null
}

type Evidence = { key: string; label: string; display: string; score: number }
type Candidate = {
  fixtureId: string
  market: Market
  selectionKey: string
  selection: string
  confidence: number
  grade: 'A+' | 'A' | 'B' | 'C'
  dataQuality: number
  evidence: Evidence[]
  features: Record<string, unknown>
}

const MODEL = 'v0-research'
const weights: Record<Market, Record<string, number>> = {
  cards: { recent: .24, venue: .20, opponent: .17, referee: .18, season: .11, h2h: .10 },
  corners: { recent: .26, venue: .24, opponent: .20, season: .18, h2h: .12 },
  goals: { recent: .24, venue: .22, opponent: .20, season: .18, h2h: .10, context: .06 },
}

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function clamp(value: number, min = 0, max = 100) { return Math.max(min, Math.min(max, value)) }
function pct(rows: MatchRow[], test: (row: MatchRow) => boolean) {
  if (!rows.length) return 0
  return rows.filter(test).length / rows.length * 100
}
function mean(rows: MatchRow[], value: (row: MatchRow) => number | null) {
  const values = rows.map(value).filter((n): n is number => n != null && Number.isFinite(n))
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0
}
function recent(rows: MatchRow[], count: number) {
  return [...rows].sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff)).slice(0, count)
}
function score(market: Market, evidence: Evidence[], dataQuality: number) {
  const w = weights[market]
  let sum = 0
  let used = 0
  for (const item of evidence) {
    if (!w[item.key]) continue
    sum += item.score * w[item.key]
    used += w[item.key]
  }
  const raw = used ? sum / used : 0
  const qualityAdjustment = .88 + clamp(dataQuality) / 100 * .12
  return Math.round(raw * qualityAdjustment)
}
function grade(confidence: number): Candidate['grade'] {
  if (confidence >= 84) return 'A+'
  if (confidence >= 78) return 'A'
  if (confidence >= 70) return 'B'
  return 'C'
}
function sampleQuality(parts: Array<[number, number, number]>) {
  const totalWeight = parts.reduce((sum, [, , weight]) => sum + weight, 0)
  if (!totalWeight) return 0
  return Math.round(parts.reduce((sum, [actual, target, weight]) => sum + clamp(actual / target, 0, 1) * weight, 0) / totalWeight * 100)
}
function displayRate(value: number) { return `${Math.round(value)}% cleared` }
function matchGoals(row: MatchRow) { return (row.home_goals ?? 0) + (row.away_goals ?? 0) }
function secondHalfGoals(row: MatchRow) {
  const ft = matchGoals(row)
  const ht = (row.half_time_home_goals ?? 0) + (row.half_time_away_goals ?? 0)
  return ft - ht
}

function teamCardCandidate(
  fixtureId: string,
  side: 'home' | 'away',
  ownRows: MatchRow[],
  opponentRows: MatchRow[],
  opponentId: string,
  referee: { yellow_cards_per_match?: number | null; matches_sample?: number | null } | null,
): Candidate {
  const r10 = recent(ownRows, 10)
  const venue10 = recent(ownRows.filter((r) => r.venue === side), 10)
  const opp10 = recent(opponentRows, 10)
  const season = recent(ownRows, 30)
  const h2h = recent(ownRows.filter((r) => r.opponent_team_id === opponentId), 5)
  const recentRate = pct(r10, (r) => (r.yellow_cards ?? -1) >= 2)
  const venueRate = pct(venue10, (r) => (r.yellow_cards ?? -1) >= 2)
  const opponentRate = pct(opp10, (r) => (r.opponent_yellow_cards ?? -1) >= 2)
  const seasonRate = pct(season, (r) => (r.yellow_cards ?? -1) >= 2)
  const h2hRate = pct(h2h, (r) => (r.yellow_cards ?? -1) >= 2)
  const refCards = Number(referee?.yellow_cards_per_match ?? 0)
  const refScore = referee ? clamp(45 + (refCards - 3.5) * 18) : 45
  const dataQuality = sampleQuality([
    [r10.length, 10, 24], [venue10.length, 10, 20], [opp10.length, 10, 17],
    [Number(referee?.matches_sample ?? 0), 10, 18], [season.length, 25, 11], [h2h.length, 4, 10],
  ])
  const evidence: Evidence[] = [
    { key: 'recent', label: 'Recent 10', display: displayRate(recentRate), score: Math.round(recentRate) },
    { key: 'venue', label: `${side === 'home' ? 'Home' : 'Away'} split`, display: displayRate(venueRate), score: Math.round(venueRate) },
    { key: 'opponent', label: 'Opponent draws cards', display: displayRate(opponentRate), score: Math.round(opponentRate) },
    { key: 'referee', label: 'Referee', display: referee ? `${refCards.toFixed(1)} yellows/match` : 'Not yet available', score: Math.round(refScore) },
    { key: 'season', label: 'Season sample', display: displayRate(seasonRate), score: Math.round(seasonRate) },
    { key: 'h2h', label: 'Recent H2H', display: h2h.length ? displayRate(h2hRate) : 'No usable sample', score: h2h.length ? Math.round(h2hRate) : 50 },
  ]
  const confidence = score('cards', evidence, dataQuality)
  return {
    fixtureId, market: 'cards', selectionKey: `${side}_cards_1_5`, selection: `${side === 'home' ? 'Home' : 'Away'} Team — 2+ Yellow Cards`,
    confidence, grade: grade(confidence), dataQuality, evidence,
    features: { recentRate, venueRate, opponentRate, seasonRate, h2hRate, refCards, samples: { recent: r10.length, venue: venue10.length, opponent: opp10.length, h2h: h2h.length } },
  }
}

function teamCornerCandidate(fixtureId: string, side: 'home' | 'away', ownRows: MatchRow[], opponentRows: MatchRow[], opponentId: string): Candidate {
  const r10 = recent(ownRows, 10)
  const venue10 = recent(ownRows.filter((r) => r.venue === side), 10)
  const opp10 = recent(opponentRows, 10)
  const season = recent(ownRows, 30)
  const h2h = recent(ownRows.filter((r) => r.opponent_team_id === opponentId), 5)
  const recentRate = pct(r10, (r) => (r.corners ?? -1) >= 5)
  const venueRate = pct(venue10, (r) => (r.corners ?? -1) >= 5)
  const opponentRate = pct(opp10, (r) => (r.opponent_corners ?? -1) >= 5)
  const seasonRate = pct(season, (r) => (r.corners ?? -1) >= 5)
  const h2hRate = pct(h2h, (r) => (r.corners ?? -1) >= 5)
  const dataQuality = sampleQuality([[r10.length,10,26],[venue10.length,10,24],[opp10.length,10,20],[season.length,25,18],[h2h.length,4,12]])
  const evidence: Evidence[] = [
    { key: 'recent', label: 'Recent 10', display: displayRate(recentRate), score: Math.round(recentRate) },
    { key: 'venue', label: `${side === 'home' ? 'Home' : 'Away'} split`, display: `${mean(venue10, (r) => r.corners).toFixed(1)} avg corners`, score: Math.round(venueRate) },
    { key: 'opponent', label: 'Opponent concedes', display: `${mean(opp10, (r) => r.opponent_corners).toFixed(1)} avg corners`, score: Math.round(opponentRate) },
    { key: 'season', label: 'Season sample', display: displayRate(seasonRate), score: Math.round(seasonRate) },
    { key: 'h2h', label: 'Recent H2H', display: h2h.length ? displayRate(h2hRate) : 'No usable sample', score: h2h.length ? Math.round(h2hRate) : 50 },
  ]
  const confidence = score('corners', evidence, dataQuality)
  return {
    fixtureId, market: 'corners', selectionKey: `${side}_corners_4_5`, selection: `${side === 'home' ? 'Home' : 'Away'} Team — 5+ Corners`,
    confidence, grade: grade(confidence), dataQuality, evidence,
    features: { recentRate, venueRate, opponentRate, seasonRate, h2hRate, samples: { recent: r10.length, venue: venue10.length, opponent: opp10.length, h2h: h2h.length } },
  }
}

function goalCandidate(fixtureId: string, kind: 'over_1_5' | 'second_half_0_5', homeRows: MatchRow[], awayRows: MatchRow[], awayId: string): Candidate {
  const home10 = recent(homeRows, 10)
  const away10 = recent(awayRows, 10)
  const homeVenue = recent(homeRows.filter((r) => r.venue === 'home'), 10)
  const awayVenue = recent(awayRows.filter((r) => r.venue === 'away'), 10)
  const h2h = recent(homeRows.filter((r) => r.opponent_team_id === awayId), 5)
  const tester = kind === 'over_1_5' ? (r: MatchRow) => matchGoals(r) >= 2 : (r: MatchRow) => secondHalfGoals(r) >= 1
  const recentRate = (pct(home10, tester) + pct(away10, tester)) / 2
  const venueRate = (pct(homeVenue, tester) + pct(awayVenue, tester)) / 2
  const seasonHome = recent(homeRows, 30)
  const seasonAway = recent(awayRows, 30)
  const seasonRate = (pct(seasonHome, tester) + pct(seasonAway, tester)) / 2
  const h2hRate = pct(h2h, tester)
  const opponentRate = recentRate
  const contextScore = 72
  const dataQuality = sampleQuality([[home10.length+away10.length,20,24],[homeVenue.length+awayVenue.length,20,22],[home10.length+away10.length,20,20],[seasonHome.length+seasonAway.length,50,18],[h2h.length,4,10],[1,1,6]])
  const evidence: Evidence[] = [
    { key: 'recent', label: 'Recent form', display: displayRate(recentRate), score: Math.round(recentRate) },
    { key: 'venue', label: 'Home/away split', display: displayRate(venueRate), score: Math.round(venueRate) },
    { key: 'opponent', label: 'Scoring/conceding mix', display: displayRate(opponentRate), score: Math.round(opponentRate) },
    { key: 'season', label: 'Season sample', display: displayRate(seasonRate), score: Math.round(seasonRate) },
    { key: 'h2h', label: 'Recent H2H', display: h2h.length ? displayRate(h2hRate) : 'No usable sample', score: h2h.length ? Math.round(h2hRate) : 50 },
    { key: 'context', label: 'Match context', display: 'Neutral until context feed', score: contextScore },
  ]
  const confidence = score('goals', evidence, dataQuality)
  return {
    fixtureId, market: 'goals', selectionKey: kind, selection: kind === 'over_1_5' ? 'Match — Over 1.5 Goals' : 'Second Half — Over 0.5 Goals',
    confidence, grade: grade(confidence), dataQuality, evidence,
    features: { recentRate, venueRate, seasonRate, h2hRate, kind, samples: { home: homeRows.length, away: awayRows.length, h2h: h2h.length } },
  }
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
  const now = new Date()
  const horizon = new Date(now.getTime() + 7 * 86400000)

  const { data: fixtures, error: fixtureError } = await supabase
    .from('fixtures')
    .select('id,kickoff,home_team_id,away_team_id,referee_id')
    .eq('status', 'scheduled')
    .gte('kickoff', now.toISOString())
    .lt('kickoff', horizon.toISOString())
    .order('kickoff')
  if (fixtureError) return new Response(JSON.stringify({ ok: false, error: fixtureError.message }), { status: 500 })

  let generated = 0
  let published = 0

  for (const fixture of fixtures ?? []) {
    const teamIds = [fixture.home_team_id, fixture.away_team_id]
    const { data: history, error: historyError } = await supabase
      .from('team_match_flat')
      .select('*')
      .in('team_id', teamIds)
      .lt('kickoff', fixture.kickoff)
      .order('kickoff', { ascending: false })
      .limit(180)
    if (historyError) continue

    const rows = (history ?? []) as MatchRow[]
    const homeRows = rows.filter((r) => r.team_id === fixture.home_team_id)
    const awayRows = rows.filter((r) => r.team_id === fixture.away_team_id)
    if (homeRows.length < 5 || awayRows.length < 5) continue

    let referee: any = null
    if (fixture.referee_id) {
      const { data } = await supabase.from('referee_profiles').select('yellow_cards_per_match,matches_sample').eq('referee_id', fixture.referee_id).order('as_of_date', { ascending: false }).limit(1).maybeSingle()
      referee = data
    }

    const candidates: Candidate[] = [
      teamCardCandidate(fixture.id, 'home', homeRows, awayRows, fixture.away_team_id, referee),
      teamCardCandidate(fixture.id, 'away', awayRows, homeRows, fixture.home_team_id, referee),
      teamCornerCandidate(fixture.id, 'home', homeRows, awayRows, fixture.away_team_id),
      teamCornerCandidate(fixture.id, 'away', awayRows, homeRows, fixture.home_team_id),
      goalCandidate(fixture.id, 'over_1_5', homeRows, awayRows, fixture.away_team_id),
      goalCandidate(fixture.id, 'second_half_0_5', homeRows, awayRows, fixture.away_team_id),
    ]

    for (const candidate of candidates) {
      const { data: snapshot, error: snapshotError } = await supabase.from('feature_snapshots').upsert({
        fixture_id: candidate.fixtureId,
        market: candidate.market,
        selection_key: candidate.selectionKey,
        selection_label: candidate.selection,
        data_quality: candidate.dataQuality,
        features: candidate.features,
        evidence: candidate.evidence,
        model_version: MODEL,
        calculated_at: new Date().toISOString(),
      }, { onConflict: 'fixture_id,selection_key,model_version' }).select('id').single()
      if (snapshotError) continue

      const publishStatus = candidate.grade === 'A+' || candidate.grade === 'A' ? (candidate.dataQuality >= 70 ? 'published' : 'suppressed') : 'suppressed'
      const { error: predictionError } = await supabase.from('predictions').upsert({
        fixture_id: candidate.fixtureId,
        feature_snapshot_id: snapshot.id,
        market: candidate.market,
        selection: candidate.selection,
        confidence: candidate.confidence,
        grade: candidate.grade,
        data_quality: candidate.dataQuality,
        evidence: candidate.evidence,
        fair_probability: null,
        model_version: MODEL,
        publish_status: publishStatus,
        generated_at: new Date().toISOString(),
      }, { onConflict: 'fixture_id,selection,model_version' })
      if (!predictionError) {
        generated += 1
        if (publishStatus === 'published') published += 1
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, fixtures: fixtures?.length ?? 0, generated, published, model: MODEL }), {
    headers: { 'content-type': 'application/json' },
  })
}
