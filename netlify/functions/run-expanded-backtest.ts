import { createClient } from '@supabase/supabase-js'

type Market = 'btts' | 'team_goals' | 'half_goals' | 'match_cards' | 'match_corners'
type MatchRow = {
  fixture_id: string
  kickoff: string
  league_id: string
  referee_id: string | null
  team_id: string
  opponent_team_id: string
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
type Evidence = { key: string; score: number }
type Evaluated = {
  market: Market
  selectionKey: string
  league: string
  confidence: number
  dataQuality: number
  win: boolean
}
type RefMatch = { kickoff: number; yellows: number }

const JOB = 'backtest-2526-v1-expanded'
const MODEL = 'v1-expanded-research-walk-forward'
const HISTORY_START = '2024-07-01T00:00:00.000Z'
const TARGET_START = '2025-07-01T00:00:00.000Z'
const TARGET_END = '2026-07-01T00:00:00.000Z'

const WEIGHTS: Record<Market, Record<string, number>> = {
  btts: { recent: .20, venue: .30, opponent: .18, season: .14, h2h: .08, lineup: .10 },
  team_goals: { recent: .20, venue: .32, opponent: .22, season: .14, h2h: .05, lineup: .07 },
  half_goals: { recent: .22, venue: .30, opponent: .18, season: .17, h2h: .08, lineup: .05 },
  match_cards: { recent: .18, venue: .25, opponent: .15, season: .12, h2h: .07, referee: .18, lineup: .05 },
  match_corners: { recent: .22, venue: .32, opponent: .18, season: .18, h2h: .06, lineup: .04 },
}

const MIN_N: Record<Market, number> = {
  btts: 120,
  team_goals: 200,
  half_goals: 120,
  match_cards: 80,
  match_corners: 80,
}

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function clamp(value: number, min = 0, max = 100) { return Math.max(min, Math.min(max, value)) }
function recent(rows: MatchRow[], count: number) { return rows.slice(Math.max(0, rows.length - count)) }
function pct(rows: MatchRow[], test: (row: MatchRow) => boolean) {
  return rows.length ? rows.filter(test).length / rows.length * 100 : 0
}
function sampleQuality(parts: Array<[number, number, number]>) {
  const total = parts.reduce((sum, [, , weight]) => sum + weight, 0)
  if (!total) return 0
  return Math.round(parts.reduce((sum, [actual, target, weight]) => sum + clamp(actual / target, 0, 1) * weight, 0) / total * 100)
}
function score(market: Market, evidence: Evidence[], quality: number) {
  const weights = WEIGHTS[market]
  let total = 0
  let used = 0
  for (const item of evidence) {
    const weight = weights[item.key]
    if (!weight) continue
    total += item.score * weight
    used += weight
  }
  const raw = used ? total / used : 0
  return Math.round(raw * (.88 + clamp(quality) / 100 * .12))
}
function avg(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0 }
function matchGoals(row: MatchRow) { return (row.home_goals ?? 0) + (row.away_goals ?? 0) }
function firstHalfGoals(row: MatchRow) { return (row.half_time_home_goals ?? 0) + (row.half_time_away_goals ?? 0) }
function totalCards(row: MatchRow) { return (row.yellow_cards ?? 0) + (row.opponent_yellow_cards ?? 0) }
function totalCorners(row: MatchRow) { return (row.corners ?? 0) + (row.opponent_corners ?? 0) }
function btts(row: MatchRow) { return (row.goals ?? 0) > 0 && (row.opponent_goals ?? 0) > 0 }
function round1(n: number) { return Math.round(n * 10) / 10 }
function wilsonLow(wins: number, n: number) {
  if (!n) return 0
  const z = 1.96
  const p = wins / n
  const denominator = 1 + z * z / n
  const centre = p + z * z / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
  return (centre - margin) / denominator * 100
}
function stat(rows: Evaluated[]) {
  const wins = rows.filter((x) => x.win).length
  return {
    n: rows.length,
    wins,
    hitRate: rows.length ? round1(wins / rows.length * 100) : 0,
    wilsonLow: round1(wilsonLow(wins, rows.length)),
  }
}

async function fetchAllRows(supabase: ReturnType<typeof createClient>) {
  const out: MatchRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('team_match_flat')
      .select('fixture_id,kickoff,league_id,referee_id,team_id,opponent_team_id,venue,goals,opponent_goals,yellow_cards,opponent_yellow_cards,corners,opponent_corners,home_goals,away_goals,half_time_home_goals,half_time_away_goals')
      .gte('kickoff', HISTORY_START)
      .lt('kickoff', TARGET_END)
      .order('kickoff', { ascending: true })
      .order('fixture_id', { ascending: true })
      .range(from, from + 999)
    if (error) throw error
    const page = (data ?? []) as MatchRow[]
    out.push(...page)
    if (page.length < 1000) break
  }
  return out
}

function jointCandidate(
  market: 'btts' | 'half_goals' | 'match_cards' | 'match_corners',
  home: MatchRow[],
  away: MatchRow[],
  awayId: string,
  tester: (row: MatchRow) => boolean,
  ref: { yellow: number; sample: number } | null,
) {
  const home10 = recent(home, 10)
  const away10 = recent(away, 10)
  const homeVenue = recent(home.filter((r) => r.venue === 'home'), 10)
  const awayVenue = recent(away.filter((r) => r.venue === 'away'), 10)
  const homeSeason = recent(home, 30)
  const awaySeason = recent(away, 30)
  const h2h = recent(home.filter((r) => r.opponent_team_id === awayId), 5)
  const recentRate = (pct(home10, tester) + pct(away10, tester)) / 2
  const venueRate = (pct(homeVenue, tester) + pct(awayVenue, tester)) / 2
  const seasonRate = (pct(homeSeason, tester) + pct(awaySeason, tester)) / 2
  const h2hRate = pct(h2h, tester)
  const refScore = ref ? clamp(40 + (ref.yellow - 3) * 17) : 50
  const evidence: Evidence[] = [
    { key: 'recent', score: Math.round(recentRate) },
    { key: 'venue', score: Math.round(venueRate) },
    { key: 'opponent', score: Math.round(recentRate) },
    { key: 'season', score: Math.round(seasonRate) },
    { key: 'h2h', score: h2h.length ? Math.round(h2hRate) : 50 },
    ...(market === 'match_cards' ? [{ key: 'referee', score: Math.round(refScore) }] : []),
    { key: 'lineup', score: 50 },
  ]
  const quality = sampleQuality([
    [home10.length + away10.length, 20, 22],
    [homeVenue.length + awayVenue.length, 20, 30],
    [homeSeason.length + awaySeason.length, 50, 18],
    [h2h.length, 4, 8],
    [0, 14, 10],
    [market === 'match_cards' ? (ref?.sample ?? 0) : 10, 10, 12],
  ])
  return { confidence: score(market, evidence, quality), quality }
}

function teamGoalCandidate(
  side: 'home' | 'away',
  threshold: 1 | 2,
  own: MatchRow[],
  opponent: MatchRow[],
  opponentId: string,
) {
  const r10 = recent(own, 10)
  const venue10 = recent(own.filter((r) => r.venue === side), 10)
  const opp10 = recent(opponent.filter((r) => r.venue === (side === 'home' ? 'away' : 'home')), 10)
  const season = recent(own, 30)
  const h2h = recent(own.filter((r) => r.opponent_team_id === opponentId), 5)
  const ownTest = (r: MatchRow) => (r.goals ?? -1) >= threshold
  const concedeTest = (r: MatchRow) => (r.opponent_goals ?? -1) >= threshold
  const evidence: Evidence[] = [
    { key: 'recent', score: Math.round(pct(r10, ownTest)) },
    { key: 'venue', score: Math.round(pct(venue10, ownTest)) },
    { key: 'opponent', score: Math.round(pct(opp10, concedeTest)) },
    { key: 'season', score: Math.round(pct(season, ownTest)) },
    { key: 'h2h', score: h2h.length ? Math.round(pct(h2h, ownTest)) : 50 },
    { key: 'lineup', score: 50 },
  ]
  const quality = sampleQuality([
    [r10.length, 10, 20],
    [venue10.length, 10, 32],
    [opp10.length, 10, 22],
    [season.length, 25, 14],
    [h2h.length, 4, 5],
    [0, 14, 7],
  ])
  return { confidence: score('team_goals', evidence, quality), quality }
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: run, error: runError } = await supabase
    .from('source_sync_runs')
    .insert({ source: 'eve-expanded-backtest', job_name: JOB, status: 'running' })
    .select('id')
    .single()
  if (runError) throw runError

  try {
    const [{ data: leagues, error: leagueError }, rows] = await Promise.all([
      supabase.from('leagues').select('id,slug,name'),
      fetchAllRows(supabase),
    ])
    if (leagueError) throw leagueError
    const leagueMap = new Map((leagues ?? []).map((l: any) => [l.id, l.slug || l.name]))

    const fixtureMap = new Map<string, { kickoff: string; leagueId: string; refereeId: string | null; home?: MatchRow; away?: MatchRow }>()
    for (const row of rows) {
      const fixture = fixtureMap.get(row.fixture_id) ?? { kickoff: row.kickoff, leagueId: row.league_id, refereeId: row.referee_id }
      if (row.venue === 'home') fixture.home = row
      else fixture.away = row
      fixtureMap.set(row.fixture_id, fixture)
    }
    const fixtures = [...fixtureMap.values()]
      .filter((f) => f.home && f.away)
      .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)) as Array<{ kickoff: string; leagueId: string; refereeId: string | null; home: MatchRow; away: MatchRow }>

    const teamHistory = new Map<string, MatchRow[]>()
    const refHistory = new Map<string, RefMatch[]>()
    const evaluated: Evaluated[] = []
    let targetFixtures = 0
    let skippedLowHistory = 0

    const appendFixture = (fixture: typeof fixtures[number]) => {
      for (const row of [fixture.home, fixture.away]) {
        const history = teamHistory.get(row.team_id) ?? []
        history.push(row)
        teamHistory.set(row.team_id, history)
      }
      if (fixture.refereeId && fixture.home.yellow_cards != null && fixture.away.yellow_cards != null) {
        const history = refHistory.get(fixture.refereeId) ?? []
        history.push({ kickoff: Date.parse(fixture.kickoff), yellows: fixture.home.yellow_cards + fixture.away.yellow_cards })
        refHistory.set(fixture.refereeId, history)
      }
    }

    for (const fixture of fixtures) {
      if (fixture.kickoff < TARGET_START) { appendFixture(fixture); continue }
      if (fixture.kickoff >= TARGET_END) break
      targetFixtures += 1

      const homeHistory = teamHistory.get(fixture.home.team_id) ?? []
      const awayHistory = teamHistory.get(fixture.away.team_id) ?? []
      if (homeHistory.length < 5 || awayHistory.length < 5) {
        skippedLowHistory += 1
        appendFixture(fixture)
        continue
      }

      const league = leagueMap.get(fixture.leagueId) ?? fixture.leagueId
      let referee: { yellow: number; sample: number } | null = null
      if (fixture.refereeId) {
        const t = Date.parse(fixture.kickoff)
        const cutoff = t - 730 * 86400000
        const prior = (refHistory.get(fixture.refereeId) ?? []).filter((r) => r.kickoff < t && r.kickoff >= cutoff)
        if (prior.length >= 3) referee = { yellow: avg(prior.map((r) => r.yellows)), sample: prior.length }
      }

      const jointInputs: Array<[Market, string, (r: MatchRow) => boolean, boolean]> = [
        ['btts', 'btts_yes', btts, btts(fixture.home)],
        ['half_goals', 'first_half_0_5', (r) => firstHalfGoals(r) >= 1, firstHalfGoals(fixture.home) >= 1],
        ['match_cards', 'match_cards_3_5', (r) => totalCards(r) >= 4, totalCards(fixture.home) >= 4],
        ['match_corners', 'match_corners_8_5', (r) => totalCorners(r) >= 9, totalCorners(fixture.home) >= 9],
      ]
      for (const [market, selectionKey, tester, win] of jointInputs) {
        const x = jointCandidate(market as 'btts' | 'half_goals' | 'match_cards' | 'match_corners', homeHistory, awayHistory, fixture.away.team_id, tester, referee)
        evaluated.push({ market, selectionKey, league, confidence: x.confidence, dataQuality: x.quality, win })
      }

      for (const [side, own, opp, opponentId, actualGoals] of [
        ['home', homeHistory, awayHistory, fixture.away.team_id, fixture.home.goals],
        ['away', awayHistory, homeHistory, fixture.home.team_id, fixture.away.goals],
      ] as const) {
        for (const threshold of [1, 2] as const) {
          const x = teamGoalCandidate(side, threshold, own, opp, opponentId)
          evaluated.push({
            market: 'team_goals',
            selectionKey: `${side}_goals_${threshold === 1 ? '0_5' : '1_5'}`,
            league,
            confidence: x.confidence,
            dataQuality: x.quality,
            win: (actualGoals ?? -1) >= threshold,
          })
        }
      }

      appendFixture(fixture)
    }

    const thresholds = Array.from({ length: 18 }, (_, i) => 60 + i * 2)
    const thresholdSummary: Record<string, any[]> = {}
    const recommendedThresholds: Record<string, any> = {}

    for (const market of Object.keys(WEIGHTS) as Market[]) {
      const options = thresholds.map((threshold) => ({
        threshold,
        ...stat(evaluated.filter((x) => x.market === market && x.dataQuality >= 70 && x.confidence >= threshold)),
      }))
      thresholdSummary[market] = options
      const eligible = options.filter((x) => x.n >= MIN_N[market])
      const fallback = options.filter((x) => x.n >= 40)
      const pool = eligible.length ? eligible : fallback
      recommendedThresholds[market] = pool.sort((a, b) => (b.wilsonLow - a.wilsonLow) || (b.n - a.n))[0] ?? null
    }

    const bySelection = [...new Set(evaluated.map((x) => x.selectionKey))].map((selectionKey) => {
      const rows = evaluated.filter((x) => x.selectionKey === selectionKey && x.dataQuality >= 70)
      return { selectionKey, ...stat(rows) }
    })

    const calibrationBands: Record<string, any[]> = {}
    for (const market of Object.keys(WEIGHTS) as Market[]) {
      calibrationBands[market] = [[0,59],[60,64],[65,69],[70,74],[75,79],[80,84],[85,89],[90,100]].map(([lo, hi]) => ({
        band: `${lo}-${hi}`,
        ...stat(evaluated.filter((x) => x.market === market && x.dataQuality >= 70 && x.confidence >= lo && x.confidence <= hi)),
      }))
    }

    const leagueGroups = new Map<string, Evaluated[]>()
    for (const row of evaluated.filter((x) => x.dataQuality >= 70)) {
      const key = `${row.league}|${row.market}`
      const list = leagueGroups.get(key) ?? []
      list.push(row)
      leagueGroups.set(key, list)
    }
    const byLeague = [...leagueGroups.entries()].map(([key, list]) => {
      const [league, market] = key.split('|')
      return { league, market, ...stat(list) }
    }).sort((a, b) => b.n - a.n)

    const summary = {
      ok: true,
      model: MODEL,
      calibrationSeason: '2025/26',
      outOfSampleSeason: '2026/27',
      historyStart: HISTORY_START.slice(0, 10),
      methodology: 'Strict walk-forward: each 2025/26 fixture is scored using only earlier matches. Home-only and away-only history are separated. Historical starting XI is unavailable, so lineup contribution is held neutral and receives no data-quality credit. Referee card history uses prior appointments only.',
      targetFixtures,
      skippedLowHistory,
      evaluatedCandidates: evaluated.length,
      dataQuality70Plus: evaluated.filter((x) => x.dataQuality >= 70).length,
      thresholds: thresholdSummary,
      recommendedThresholds,
      bySelection,
      calibrationBands,
      leagueMarkets: byLeague,
      fairProbabilityMethod: 'For live 2026/27 research signals, conservative fair probability is the 95% Wilson lower bound at the selected 2025/26 threshold. This mirrors the core Value Engine approach.',
      caveat: 'This calibrates hit-rate, not profitability. 2026/27 remains the true out-of-sample validation season; bookmaker value must still be tested separately before promoting an expanded market to Best Bets.',
    }

    await supabase.from('source_sync_runs').update({
      finished_at: new Date().toISOString(),
      status: 'success',
      rows_upserted: evaluated.length,
      error_message: JSON.stringify(summary),
    }).eq('id', run.id)

    return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await supabase.from('source_sync_runs').update({ finished_at: new Date().toISOString(), status: 'failed', error_message: message }).eq('id', run.id)
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
