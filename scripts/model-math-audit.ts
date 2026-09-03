import { createClient } from '@supabase/supabase-js'

type CoreMarket = 'cards' | 'corners' | 'goals'
type ExpandedMarket = 'btts' | 'team_goals' | 'half_goals' | 'match_cards' | 'match_corners'
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
type RefMatch = { kickoff: number; yellows: number }
type EvalRow = {
  family: 'core' | 'expanded'
  market: string
  selectionKey: string
  baseline: number
  corrected: number
  baselineDq: number
  correctedDq: number
  win: boolean
}

const HISTORY_START = '2024-07-01T00:00:00.000Z'
const TARGET_START = '2025-07-01T00:00:00.000Z'
const TARGET_END = '2026-07-01T00:00:00.000Z'

const CORE_WEIGHTS: Record<CoreMarket, Record<string, number>> = {
  cards: { recent: .24, venue: .20, opponent: .17, referee: .18, season: .11, h2h: .10 },
  corners: { recent: .26, venue: .24, opponent: .20, season: .18, h2h: .12 },
  goals: { recent: .24, venue: .22, opponent: .20, season: .18, h2h: .10, context: .06 },
}
const EXPANDED_WEIGHTS: Record<ExpandedMarket, Record<string, number>> = {
  btts: { recent: .20, venue: .30, opponent: .18, season: .14, h2h: .08, lineup: .10 },
  team_goals: { recent: .20, venue: .32, opponent: .22, season: .14, h2h: .05, lineup: .07 },
  half_goals: { recent: .22, venue: .30, opponent: .18, season: .17, h2h: .08, lineup: .05 },
  match_cards: { recent: .18, venue: .25, opponent: .15, season: .12, h2h: .07, referee: .18, lineup: .05 },
  match_corners: { recent: .22, venue: .32, opponent: .18, season: .18, h2h: .06, lineup: .04 },
}

const CORE_LIVE_THRESHOLDS: Record<CoreMarket, number> = { cards: 70, corners: 82, goals: 90 }
const EXPANDED_LIVE_THRESHOLDS: Record<ExpandedMarket, number> = {
  btts: 66,
  team_goals: 88,
  half_goals: 82,
  match_cards: 68,
  match_corners: 68,
}
const EXPANDED_MIN_N: Record<ExpandedMarket, number> = {
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
function weightedScore(weights: Record<string, number>, evidence: Evidence[], quality: number, omit: string[] = []) {
  let total = 0
  let used = 0
  for (const item of evidence) {
    const weight = weights[item.key]
    if (!weight || omit.includes(item.key)) continue
    total += item.score * weight
    used += weight
  }
  const raw = used ? total / used : 0
  return Math.round(raw * (.88 + clamp(quality) / 100 * .12))
}
function avg(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0 }
function matchGoals(row: MatchRow) { return (row.home_goals ?? 0) + (row.away_goals ?? 0) }
function firstHalfGoals(row: MatchRow) { return (row.half_time_home_goals ?? 0) + (row.half_time_away_goals ?? 0) }
function secondHalfGoals(row: MatchRow) { return matchGoals(row) - firstHalfGoals(row) }
function totalCards(row: MatchRow) { return (row.yellow_cards ?? 0) + (row.opponent_yellow_cards ?? 0) }
function totalCorners(row: MatchRow) { return (row.corners ?? 0) + (row.opponent_corners ?? 0) }
function btts(row: MatchRow) { return (row.goals ?? 0) > 0 && (row.opponent_goals ?? 0) > 0 }
function round1(value: number) { return Math.round(value * 10) / 10 }
function wilsonLow(wins: number, n: number) {
  if (!n) return 0
  const z = 1.96
  const p = wins / n
  const d = 1 + z * z / n
  const centre = p + z * z / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
  return (centre - margin) / d * 100
}
function stat(rows: EvalRow[]) {
  const wins = rows.filter((row) => row.win).length
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

function coreCard(side: 'home' | 'away', own: MatchRow[], opp: MatchRow[], opponentId: string, ref: { yellow: number; sample: number } | null) {
  const r10 = recent(own, 10)
  const venue10 = recent(own.filter((r) => r.venue === side), 10)
  const opp10 = recent(opp, 10)
  const trailing30 = recent(own, 30)
  const h2h = recent(own.filter((r) => r.opponent_team_id === opponentId), 5)
  const baselineRefScore = ref ? clamp(45 + (ref.yellow - 3.5) * 18) : 45
  const correctedRefScore = ref ? clamp(45 + (ref.yellow - 3.5) * 18) : 50
  const baseEvidence: Evidence[] = [
    { key: 'recent', score: Math.round(pct(r10, (r) => (r.yellow_cards ?? -1) >= 2)) },
    { key: 'venue', score: Math.round(pct(venue10, (r) => (r.yellow_cards ?? -1) >= 2)) },
    { key: 'opponent', score: Math.round(pct(opp10, (r) => (r.opponent_yellow_cards ?? -1) >= 2)) },
    { key: 'referee', score: Math.round(baselineRefScore) },
    { key: 'season', score: Math.round(pct(trailing30, (r) => (r.yellow_cards ?? -1) >= 2)) },
    { key: 'h2h', score: h2h.length ? Math.round(pct(h2h, (r) => (r.yellow_cards ?? -1) >= 2)) : 50 },
  ]
  const correctedEvidence = baseEvidence.map((e) => e.key === 'referee' ? { ...e, score: Math.round(correctedRefScore) } : e)
  const dq = sampleQuality([[r10.length,10,24],[venue10.length,10,20],[opp10.length,10,17],[ref?.sample ?? 0,10,18],[trailing30.length,25,11],[h2h.length,4,10]])
  return {
    baseline: weightedScore(CORE_WEIGHTS.cards, baseEvidence, dq),
    corrected: weightedScore(CORE_WEIGHTS.cards, correctedEvidence, dq),
    baselineDq: dq,
    correctedDq: dq,
  }
}

function coreCorner(side: 'home' | 'away', own: MatchRow[], opp: MatchRow[], opponentId: string) {
  const r10 = recent(own, 10)
  const venue10 = recent(own.filter((r) => r.venue === side), 10)
  const opp10 = recent(opp, 10)
  const trailing30 = recent(own, 30)
  const h2h = recent(own.filter((r) => r.opponent_team_id === opponentId), 5)
  const evidence: Evidence[] = [
    { key: 'recent', score: Math.round(pct(r10, (r) => (r.corners ?? -1) >= 5)) },
    { key: 'venue', score: Math.round(pct(venue10, (r) => (r.corners ?? -1) >= 5)) },
    { key: 'opponent', score: Math.round(pct(opp10, (r) => (r.opponent_corners ?? -1) >= 5)) },
    { key: 'season', score: Math.round(pct(trailing30, (r) => (r.corners ?? -1) >= 5)) },
    { key: 'h2h', score: h2h.length ? Math.round(pct(h2h, (r) => (r.corners ?? -1) >= 5)) : 50 },
  ]
  const dq = sampleQuality([[r10.length,10,26],[venue10.length,10,24],[opp10.length,10,20],[trailing30.length,25,18],[h2h.length,4,12]])
  const score = weightedScore(CORE_WEIGHTS.corners, evidence, dq)
  return { baseline: score, corrected: score, baselineDq: dq, correctedDq: dq }
}

function coreGoal(kind: 'over_1_5' | 'second_half_0_5', home: MatchRow[], away: MatchRow[], awayId: string) {
  const home10 = recent(home, 10)
  const away10 = recent(away, 10)
  const homeVenue = recent(home.filter((r) => r.venue === 'home'), 10)
  const awayVenue = recent(away.filter((r) => r.venue === 'away'), 10)
  const homeTrailing30 = recent(home, 30)
  const awayTrailing30 = recent(away, 30)
  const h2h = recent(home.filter((r) => r.opponent_team_id === awayId), 5)
  const tester = kind === 'over_1_5' ? (r: MatchRow) => matchGoals(r) >= 2 : (r: MatchRow) => secondHalfGoals(r) >= 1
  const recentRate = (pct(home10, tester) + pct(away10, tester)) / 2
  const venueRate = (pct(homeVenue, tester) + pct(awayVenue, tester)) / 2
  const trailingRate = (pct(homeTrailing30, tester) + pct(awayTrailing30, tester)) / 2
  const h2hRate = pct(h2h, tester)
  const baselineEvidence: Evidence[] = [
    { key: 'recent', score: Math.round(recentRate) },
    { key: 'venue', score: Math.round(venueRate) },
    { key: 'opponent', score: Math.round(recentRate) },
    { key: 'season', score: Math.round(trailingRate) },
    { key: 'h2h', score: h2h.length ? Math.round(h2hRate) : 50 },
    { key: 'context', score: 72 },
  ]
  const baselineDq = sampleQuality([[home10.length+away10.length,20,24],[homeVenue.length+awayVenue.length,20,22],[home10.length+away10.length,20,20],[homeTrailing30.length+awayTrailing30.length,50,18],[h2h.length,4,10],[1,1,6]])
  // Corrected version removes the duplicate "opponent" copy of recent form and the
  // constant 72 "neutral context" boost. Both absent inputs are also removed from DQ.
  const correctedEvidence = baselineEvidence.filter((e) => e.key !== 'opponent' && e.key !== 'context')
  const correctedDq = sampleQuality([[home10.length+away10.length,20,24],[homeVenue.length+awayVenue.length,20,22],[homeTrailing30.length+awayTrailing30.length,50,18],[h2h.length,4,10]])
  return {
    baseline: weightedScore(CORE_WEIGHTS.goals, baselineEvidence, baselineDq),
    corrected: weightedScore(CORE_WEIGHTS.goals, correctedEvidence, correctedDq),
    baselineDq,
    correctedDq,
  }
}

function expandedJoint(
  market: Exclude<ExpandedMarket, 'team_goals'>,
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
  const homeTrailing30 = recent(home, 30)
  const awayTrailing30 = recent(away, 30)
  const h2h = recent(home.filter((r) => r.opponent_team_id === awayId), 5)
  const recentRate = (pct(home10, tester) + pct(away10, tester)) / 2
  const venueRate = (pct(homeVenue, tester) + pct(awayVenue, tester)) / 2
  const trailingRate = (pct(homeTrailing30, tester) + pct(awayTrailing30, tester)) / 2
  const h2hRate = pct(h2h, tester)
  const refereeScore = ref ? clamp(40 + (ref.yellow - 3) * 17) : 50
  const baselineEvidence: Evidence[] = [
    { key: 'recent', score: Math.round(recentRate) },
    { key: 'venue', score: Math.round(venueRate) },
    { key: 'opponent', score: Math.round(recentRate) },
    { key: 'season', score: Math.round(trailingRate) },
    { key: 'h2h', score: h2h.length ? Math.round(h2hRate) : 50 },
    ...(market === 'match_cards' ? [{ key: 'referee', score: Math.round(refereeScore) }] : []),
    { key: 'lineup', score: 50 },
  ]
  const baselineDq = sampleQuality([
    [home10.length + away10.length, 20, 22],
    [homeVenue.length + awayVenue.length, 20, 30],
    [homeTrailing30.length + awayTrailing30.length, 50, 18],
    [h2h.length, 4, 8],
    [0, 14, 10],
    [market === 'match_cards' ? (ref?.sample ?? 0) : 10, 10, 12],
  ])
  // Corrected joint model removes the duplicated recentRate masquerading as an
  // opposition profile. For non-card markets it also removes the unexplained 12%
  // full DQ credit that currently exists despite there being no referee factor.
  const correctedEvidence = baselineEvidence.filter((e) => e.key !== 'opponent')
  const correctedDqParts: Array<[number, number, number]> = [
    [home10.length + away10.length, 20, 22],
    [homeVenue.length + awayVenue.length, 20, 30],
    [homeTrailing30.length + awayTrailing30.length, 50, 18],
    [h2h.length, 4, 8],
    [0, 14, 10],
  ]
  if (market === 'match_cards') correctedDqParts.push([ref?.sample ?? 0, 10, 12])
  const correctedDq = sampleQuality(correctedDqParts)
  return {
    baseline: weightedScore(EXPANDED_WEIGHTS[market], baselineEvidence, baselineDq),
    corrected: weightedScore(EXPANDED_WEIGHTS[market], correctedEvidence, correctedDq),
    baselineDq,
    correctedDq,
  }
}

function expandedTeamGoal(side: 'home' | 'away', threshold: 1 | 2, own: MatchRow[], opponent: MatchRow[], opponentId: string) {
  const r10 = recent(own, 10)
  const venue10 = recent(own.filter((r) => r.venue === side), 10)
  const opp10 = recent(opponent.filter((r) => r.venue === (side === 'home' ? 'away' : 'home')), 10)
  const trailing30 = recent(own, 30)
  const h2h = recent(own.filter((r) => r.opponent_team_id === opponentId), 5)
  const ownTest = (r: MatchRow) => (r.goals ?? -1) >= threshold
  const concedeTest = (r: MatchRow) => (r.opponent_goals ?? -1) >= threshold
  const evidence: Evidence[] = [
    { key: 'recent', score: Math.round(pct(r10, ownTest)) },
    { key: 'venue', score: Math.round(pct(venue10, ownTest)) },
    { key: 'opponent', score: Math.round(pct(opp10, concedeTest)) },
    { key: 'season', score: Math.round(pct(trailing30, ownTest)) },
    { key: 'h2h', score: h2h.length ? Math.round(pct(h2h, ownTest)) : 50 },
    { key: 'lineup', score: 50 },
  ]
  const dq = sampleQuality([[r10.length,10,20],[venue10.length,10,32],[opp10.length,10,22],[trailing30.length,25,14],[h2h.length,4,5],[0,14,7]])
  const score = weightedScore(EXPANDED_WEIGHTS.team_goals, evidence, dq)
  return { baseline: score, corrected: score, baselineDq: dq, correctedDq: dq }
}

function compareAtThreshold(rows: EvalRow[], threshold: number) {
  const baselineRows = rows.filter((r) => r.baselineDq >= 70 && r.baseline >= threshold)
  const correctedRows = rows.filter((r) => r.correctedDq >= 70 && r.corrected >= threshold)
  const baselineSet = new Set(baselineRows)
  const correctedSet = new Set(correctedRows)
  return {
    threshold,
    baseline: stat(baselineRows),
    corrected: stat(correctedRows),
    movedIn: correctedRows.filter((r) => !baselineSet.has(r)).length,
    movedOut: baselineRows.filter((r) => !correctedSet.has(r)).length,
  }
}

function bestCorrected(rows: EvalRow[], thresholds: number[], minN: number) {
  const options = thresholds.map((threshold) => ({
    threshold,
    ...stat(rows.filter((r) => r.correctedDq >= 70 && r.corrected >= threshold)),
  }))
  const eligible = options.filter((x) => x.n >= minN)
  const fallback = options.filter((x) => x.n >= 40)
  const pool = eligible.length ? eligible : fallback
  return [...pool].sort((a, b) => (b.wilsonLow - a.wilsonLow) || (b.n - a.n))[0] ?? null
}

async function main() {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const rows = await fetchAllRows(supabase)
  const fixtureMap = new Map<string, { kickoff: string; refereeId: string | null; home?: MatchRow; away?: MatchRow }>()
  for (const row of rows) {
    const fixture = fixtureMap.get(row.fixture_id) ?? { kickoff: row.kickoff, refereeId: row.referee_id }
    if (row.venue === 'home') fixture.home = row
    else fixture.away = row
    fixtureMap.set(row.fixture_id, fixture)
  }
  const fixtures = [...fixtureMap.values()]
    .filter((f) => f.home && f.away)
    .sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)) as Array<{ kickoff: string; refereeId: string | null; home: MatchRow; away: MatchRow }>

  const teamHistory = new Map<string, MatchRow[]>()
  const refHistory = new Map<string, RefMatch[]>()
  const evaluated: EvalRow[] = []
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

    let referee: { yellow: number; sample: number } | null = null
    if (fixture.refereeId) {
      const t = Date.parse(fixture.kickoff)
      const cutoff = t - 730 * 86400000
      const prior = (refHistory.get(fixture.refereeId) ?? []).filter((r) => r.kickoff < t && r.kickoff >= cutoff)
      if (prior.length >= 3) referee = { yellow: avg(prior.map((r) => r.yellows)), sample: prior.length }
    }

    for (const [side, own, opp, opponentId, actualCards, actualCorners] of [
      ['home', homeHistory, awayHistory, fixture.away.team_id, fixture.home.yellow_cards, fixture.home.corners],
      ['away', awayHistory, homeHistory, fixture.home.team_id, fixture.away.yellow_cards, fixture.away.corners],
    ] as const) {
      if (actualCards != null) {
        const x = coreCard(side, own, opp, opponentId, referee)
        evaluated.push({ family:'core', market:'cards', selectionKey:`${side}_cards_1_5`, ...x, win:actualCards >= 2 })
      }
      if (actualCorners != null) {
        const x = coreCorner(side, own, opp, opponentId)
        evaluated.push({ family:'core', market:'corners', selectionKey:`${side}_corners_4_5`, ...x, win:actualCorners >= 5 })
      }
    }

    if (fixture.home.home_goals != null && fixture.home.away_goals != null) {
      const x = coreGoal('over_1_5', homeHistory, awayHistory, fixture.away.team_id)
      evaluated.push({ family:'core', market:'goals', selectionKey:'over_1_5', ...x, win:matchGoals(fixture.home) >= 2 })
    }
    if (fixture.home.half_time_home_goals != null && fixture.home.half_time_away_goals != null) {
      const x = coreGoal('second_half_0_5', homeHistory, awayHistory, fixture.away.team_id)
      evaluated.push({ family:'core', market:'goals', selectionKey:'second_half_0_5', ...x, win:secondHalfGoals(fixture.home) >= 1 })
    }

    const jointInputs: Array<[Exclude<ExpandedMarket, 'team_goals'>, string, (r: MatchRow) => boolean, boolean]> = [
      ['btts', 'btts_yes', btts, btts(fixture.home)],
      ['half_goals', 'first_half_0_5', (r) => firstHalfGoals(r) >= 1, firstHalfGoals(fixture.home) >= 1],
      ['match_cards', 'match_cards_3_5', (r) => totalCards(r) >= 4, totalCards(fixture.home) >= 4],
      ['match_corners', 'match_corners_8_5', (r) => totalCorners(r) >= 9, totalCorners(fixture.home) >= 9],
    ]
    for (const [market, selectionKey, tester, win] of jointInputs) {
      const x = expandedJoint(market, homeHistory, awayHistory, fixture.away.team_id, tester, referee)
      evaluated.push({ family:'expanded', market, selectionKey, ...x, win })
    }

    for (const [side, own, opp, opponentId, actualGoals] of [
      ['home', homeHistory, awayHistory, fixture.away.team_id, fixture.home.goals],
      ['away', awayHistory, homeHistory, fixture.home.team_id, fixture.away.goals],
    ] as const) {
      for (const threshold of [1, 2] as const) {
        const x = expandedTeamGoal(side, threshold, own, opp, opponentId)
        evaluated.push({
          family:'expanded', market:'team_goals', selectionKey:`${side}_goals_${threshold === 1 ? '0_5' : '1_5'}`,
          ...x, win:(actualGoals ?? -1) >= threshold,
        })
      }
    }

    appendFixture(fixture)
  }

  const coreThresholds = [60,65,70,75,78,80,82,84,86,88,90]
  const expandedThresholds = Array.from({ length: 18 }, (_, i) => 60 + i * 2)
  const core: Record<string, unknown> = {}
  for (const market of Object.keys(CORE_WEIGHTS) as CoreMarket[]) {
    const marketRows = evaluated.filter((r) => r.family === 'core' && r.market === market)
    core[market] = {
      productionThreshold: compareAtThreshold(marketRows, CORE_LIVE_THRESHOLDS[market]),
      correctedRecommended: bestCorrected(marketRows, coreThresholds, 50),
      totalCandidates: marketRows.length,
    }
  }
  const expanded: Record<string, unknown> = {}
  for (const market of Object.keys(EXPANDED_WEIGHTS) as ExpandedMarket[]) {
    const marketRows = evaluated.filter((r) => r.family === 'expanded' && r.market === market)
    expanded[market] = {
      productionThreshold: compareAtThreshold(marketRows, EXPANDED_LIVE_THRESHOLDS[market]),
      correctedRecommended: bestCorrected(marketRows, expandedThresholds, EXPANDED_MIN_N[market]),
      totalCandidates: marketRows.length,
    }
  }

  const summary = {
    ok: true,
    readOnly: true,
    targetSeason: '2025/26',
    methodology: 'Strict walk-forward. Baseline reproduces current production/backtest formulas. Corrected removes duplicated evidence and fake neutral/data-quality boosts only; team-goal and corner formulas are unchanged.',
    targetFixtures,
    skippedLowHistory,
    evaluatedCandidates: evaluated.length,
    correctionsTested: [
      'Core cards: missing referee score 45 -> neutral 50.',
      'Core goals: remove duplicated recentRate used as opponent evidence.',
      'Core goals: remove constant context score 72 and its automatic DQ credit until a real context feed exists.',
      'Expanded joint markets: remove duplicated recentRate used as opposition profile.',
      'Expanded non-card joint markets: remove unexplained 12% automatic DQ credit for a referee factor they do not use.',
      'Season calculation is not altered in this audit; it remains trailing 30 and should be relabelled accordingly.',
    ],
    core,
    expanded,
  }

  console.log('=== EVE MODEL MATH AUDIT ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exit(1)
})
