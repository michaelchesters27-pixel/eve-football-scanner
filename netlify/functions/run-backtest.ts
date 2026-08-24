import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

type Market = 'cards' | 'corners' | 'goals'
type MatchRow = {
  fixture_id: string
  kickoff: string
  league_id: string
  referee_id: string | null
  team_id: string
  opponent_team_id: string
  venue: 'home' | 'away'
  goals: number | null
  yellow_cards: number | null
  corners: number | null
  fouls: number | null
  opponent_yellow_cards: number | null
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
  confidenceNoH2H: number
  confidenceNoRef: number | null
  dataQuality: number
  win: boolean
}
type RefMatch = { kickoff: number; yellows: number; fouls: number }

const JOB = 'backtest-2526-v0'
const TARGET_START = '2025-07-01T00:00:00.000Z'
const TARGET_END = '2026-07-01T00:00:00.000Z'
const HISTORY_START = '2024-07-01T00:00:00.000Z'
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
function recent(rows: MatchRow[], count: number) { return rows.slice(Math.max(0, rows.length - count)) }
function sampleQuality(parts: Array<[number, number, number]>) {
  const totalWeight = parts.reduce((sum, [, , weight]) => sum + weight, 0)
  return totalWeight ? Math.round(parts.reduce((sum, [actual, target, weight]) => sum + clamp(actual / target, 0, 1) * weight, 0) / totalWeight * 100) : 0
}
function score(market: Market, evidence: Evidence[], dataQuality: number, omit: string[] = []) {
  const w = weights[market]
  let sum = 0
  let used = 0
  for (const item of evidence) {
    if (omit.includes(item.key) || !w[item.key]) continue
    sum += item.score * w[item.key]
    used += w[item.key]
  }
  const raw = used ? sum / used : 0
  return Math.round(raw * (.88 + clamp(dataQuality) / 100 * .12))
}
function matchGoals(row: MatchRow) { return (row.home_goals ?? 0) + (row.away_goals ?? 0) }
function secondHalfGoals(row: MatchRow) {
  return matchGoals(row) - ((row.half_time_home_goals ?? 0) + (row.half_time_away_goals ?? 0))
}
function avg(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0 }
function round1(n: number) { return Math.round(n * 10) / 10 }
function wilsonLow(wins: number, n: number) {
  if (!n) return 0
  const z = 1.96
  const p = wins / n
  const d = 1 + z * z / n
  const centre = p + z * z / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n)
  return (centre - margin) / d * 100
}
function stat(rows: Evaluated[]) {
  const wins = rows.filter((x) => x.win).length
  return { n: rows.length, wins, hitRate: rows.length ? round1(wins / rows.length * 100) : 0, wilsonLow: round1(wilsonLow(wins, rows.length)) }
}

async function fetchAllRows(supabase: ReturnType<typeof createClient>) {
  const all: MatchRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('team_match_flat')
      .select('fixture_id,kickoff,league_id,referee_id,team_id,opponent_team_id,venue,goals,yellow_cards,corners,fouls,opponent_yellow_cards,opponent_corners,home_goals,away_goals,half_time_home_goals,half_time_away_goals')
      .gte('kickoff', HISTORY_START)
      .lt('kickoff', TARGET_END)
      .order('kickoff', { ascending: true })
      .order('fixture_id', { ascending: true })
      .range(from, from + 999)
    if (error) throw error
    const page = (data ?? []) as MatchRow[]
    all.push(...page)
    if (page.length < 1000) break
  }
  return all
}

function cardEvidence(side: 'home' | 'away', own: MatchRow[], opp: MatchRow[], opponentId: string, ref: { yellow: number; sample: number } | null) {
  const r10 = recent(own, 10)
  const venue10 = recent(own.filter((r) => r.venue === side), 10)
  const opp10 = recent(opp, 10)
  const season = recent(own, 30)
  const h2h = recent(own.filter((r) => r.opponent_team_id === opponentId), 5)
  const refScore = ref ? clamp(45 + (ref.yellow - 3.5) * 18) : 45
  const evidence: Evidence[] = [
    { key: 'recent', score: Math.round(pct(r10, (r) => (r.yellow_cards ?? -1) >= 2)) },
    { key: 'venue', score: Math.round(pct(venue10, (r) => (r.yellow_cards ?? -1) >= 2)) },
    { key: 'opponent', score: Math.round(pct(opp10, (r) => (r.opponent_yellow_cards ?? -1) >= 2)) },
    { key: 'referee', score: Math.round(refScore) },
    { key: 'season', score: Math.round(pct(season, (r) => (r.yellow_cards ?? -1) >= 2)) },
    { key: 'h2h', score: h2h.length ? Math.round(pct(h2h, (r) => (r.yellow_cards ?? -1) >= 2)) : 50 },
  ]
  const dq = sampleQuality([[r10.length,10,24],[venue10.length,10,20],[opp10.length,10,17],[ref?.sample ?? 0,10,18],[season.length,25,11],[h2h.length,4,10]])
  return { evidence, dq }
}
function cornerEvidence(side: 'home' | 'away', own: MatchRow[], opp: MatchRow[], opponentId: string) {
  const r10 = recent(own, 10)
  const venue10 = recent(own.filter((r) => r.venue === side), 10)
  const opp10 = recent(opp, 10)
  const season = recent(own, 30)
  const h2h = recent(own.filter((r) => r.opponent_team_id === opponentId), 5)
  const evidence: Evidence[] = [
    { key: 'recent', score: Math.round(pct(r10, (r) => (r.corners ?? -1) >= 5)) },
    { key: 'venue', score: Math.round(pct(venue10, (r) => (r.corners ?? -1) >= 5)) },
    { key: 'opponent', score: Math.round(pct(opp10, (r) => (r.opponent_corners ?? -1) >= 5)) },
    { key: 'season', score: Math.round(pct(season, (r) => (r.corners ?? -1) >= 5)) },
    { key: 'h2h', score: h2h.length ? Math.round(pct(h2h, (r) => (r.corners ?? -1) >= 5)) : 50 },
  ]
  const dq = sampleQuality([[r10.length,10,26],[venue10.length,10,24],[opp10.length,10,20],[season.length,25,18],[h2h.length,4,12]])
  return { evidence, dq }
}
function goalEvidence(kind: 'over_1_5' | 'second_half_0_5', home: MatchRow[], away: MatchRow[], awayId: string) {
  const home10 = recent(home, 10), away10 = recent(away, 10)
  const homeVenue = recent(home.filter((r) => r.venue === 'home'), 10)
  const awayVenue = recent(away.filter((r) => r.venue === 'away'), 10)
  const seasonHome = recent(home, 30), seasonAway = recent(away, 30)
  const h2h = recent(home.filter((r) => r.opponent_team_id === awayId), 5)
  const test = kind === 'over_1_5' ? (r: MatchRow) => matchGoals(r) >= 2 : (r: MatchRow) => secondHalfGoals(r) >= 1
  const recentRate = (pct(home10, test) + pct(away10, test)) / 2
  const evidence: Evidence[] = [
    { key: 'recent', score: Math.round(recentRate) },
    { key: 'venue', score: Math.round((pct(homeVenue, test) + pct(awayVenue, test)) / 2) },
    { key: 'opponent', score: Math.round(recentRate) },
    { key: 'season', score: Math.round((pct(seasonHome, test) + pct(seasonAway, test)) / 2) },
    { key: 'h2h', score: h2h.length ? Math.round(pct(h2h, test)) : 50 },
    { key: 'context', score: 72 },
  ]
  const dq = sampleQuality([[home10.length+away10.length,20,24],[homeVenue.length+awayVenue.length,20,22],[home10.length+away10.length,20,20],[seasonHome.length+seasonAway.length,50,18],[h2h.length,4,10],[1,1,6]])
  return { evidence, dq }
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as any },
  })
  const { data: run, error: runError } = await supabase.from('source_sync_runs').insert({ source: 'eve-backtest', job_name: JOB, status: 'running' }).select('id').single()
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
      const f = fixtureMap.get(row.fixture_id) ?? { kickoff: row.kickoff, leagueId: row.league_id, refereeId: row.referee_id }
      if (row.venue === 'home') f.home = row
      else f.away = row
      fixtureMap.set(row.fixture_id, f)
    }
    const fixtures = [...fixtureMap.values()].filter((f) => f.home && f.away).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff)) as Array<{ kickoff: string; leagueId: string; refereeId: string | null; home: MatchRow; away: MatchRow }>

    const teamHistory = new Map<string, MatchRow[]>()
    const refHistory = new Map<string, RefMatch[]>()
    const evaluated: Evaluated[] = []
    let targetFixtures = 0
    let skippedLowHistory = 0

    const appendFixture = (f: typeof fixtures[number]) => {
      for (const row of [f.home, f.away]) {
        const arr = teamHistory.get(row.team_id) ?? []
        arr.push(row)
        teamHistory.set(row.team_id, arr)
      }
      if (f.refereeId && f.home.yellow_cards != null && f.away.yellow_cards != null) {
        const arr = refHistory.get(f.refereeId) ?? []
        arr.push({ kickoff: Date.parse(f.kickoff), yellows: f.home.yellow_cards + f.away.yellow_cards, fouls: (f.home.fouls ?? 0) + (f.away.fouls ?? 0) })
        refHistory.set(f.refereeId, arr)
      }
    }

    for (const f of fixtures) {
      const t = Date.parse(f.kickoff)
      if (f.kickoff < TARGET_START) { appendFixture(f); continue }
      if (f.kickoff >= TARGET_END) break
      targetFixtures += 1
      const homeHist = teamHistory.get(f.home.team_id) ?? []
      const awayHist = teamHistory.get(f.away.team_id) ?? []
      if (homeHist.length < 5 || awayHist.length < 5) {
        skippedLowHistory += 1
        appendFixture(f)
        continue
      }
      const league = leagueMap.get(f.leagueId) ?? f.leagueId
      let ref: { yellow: number; sample: number } | null = null
      if (f.refereeId) {
        const cutoff = t - 730 * 86400000
        const refs = (refHistory.get(f.refereeId) ?? []).filter((r) => r.kickoff < t && r.kickoff >= cutoff)
        if (refs.length >= 3) ref = { yellow: avg(refs.map((r) => r.yellows)), sample: refs.length }
      }

      if (f.home.yellow_cards != null) {
        const x = cardEvidence('home', homeHist, awayHist, f.away.team_id, ref)
        evaluated.push({ market:'cards', selectionKey:'home_cards_1_5', league, confidence:score('cards',x.evidence,x.dq), confidenceNoH2H:score('cards',x.evidence,x.dq,['h2h']), confidenceNoRef:score('cards',x.evidence,x.dq,['referee']), dataQuality:x.dq, win:f.home.yellow_cards >= 2 })
      }
      if (f.away.yellow_cards != null) {
        const x = cardEvidence('away', awayHist, homeHist, f.home.team_id, ref)
        evaluated.push({ market:'cards', selectionKey:'away_cards_1_5', league, confidence:score('cards',x.evidence,x.dq), confidenceNoH2H:score('cards',x.evidence,x.dq,['h2h']), confidenceNoRef:score('cards',x.evidence,x.dq,['referee']), dataQuality:x.dq, win:f.away.yellow_cards >= 2 })
      }
      if (f.home.corners != null) {
        const x = cornerEvidence('home', homeHist, awayHist, f.away.team_id)
        evaluated.push({ market:'corners', selectionKey:'home_corners_4_5', league, confidence:score('corners',x.evidence,x.dq), confidenceNoH2H:score('corners',x.evidence,x.dq,['h2h']), confidenceNoRef:null, dataQuality:x.dq, win:f.home.corners >= 5 })
      }
      if (f.away.corners != null) {
        const x = cornerEvidence('away', awayHist, homeHist, f.home.team_id)
        evaluated.push({ market:'corners', selectionKey:'away_corners_4_5', league, confidence:score('corners',x.evidence,x.dq), confidenceNoH2H:score('corners',x.evidence,x.dq,['h2h']), confidenceNoRef:null, dataQuality:x.dq, win:f.away.corners >= 5 })
      }
      if (f.home.home_goals != null && f.home.away_goals != null) {
        const x = goalEvidence('over_1_5', homeHist, awayHist, f.away.team_id)
        evaluated.push({ market:'goals', selectionKey:'over_1_5', league, confidence:score('goals',x.evidence,x.dq), confidenceNoH2H:score('goals',x.evidence,x.dq,['h2h']), confidenceNoRef:null, dataQuality:x.dq, win:matchGoals(f.home) >= 2 })
      }
      if (f.home.half_time_home_goals != null && f.home.half_time_away_goals != null) {
        const x = goalEvidence('second_half_0_5', homeHist, awayHist, f.away.team_id)
        evaluated.push({ market:'goals', selectionKey:'second_half_0_5', league, confidence:score('goals',x.evidence,x.dq), confidenceNoH2H:score('goals',x.evidence,x.dq,['h2h']), confidenceNoRef:null, dataQuality:x.dq, win:secondHalfGoals(f.home) >= 1 })
      }
      appendFixture(f)
    }

    const thresholds = [60,65,70,75,78,80,82,84,86,88,90]
    const thresholdSummary: Record<string, any> = {}
    for (const market of ['cards','corners','goals'] as Market[]) {
      thresholdSummary[market] = thresholds.map((threshold) => ({ threshold, ...stat(evaluated.filter((x) => x.market === market && x.dataQuality >= 70 && x.confidence >= threshold)) }))
    }
    thresholdSummary.all = thresholds.map((threshold) => ({ threshold, ...stat(evaluated.filter((x) => x.dataQuality >= 70 && x.confidence >= threshold)) }))

    const baseline = evaluated.filter((x) => x.dataQuality >= 70 && x.confidence >= 78)
    const bySelection = [...new Set(evaluated.map((x) => x.selectionKey))].map((selectionKey) => ({ selectionKey, ...stat(baseline.filter((x) => x.selectionKey === selectionKey)) }))
    const leagueGroups = new Map<string, Evaluated[]>()
    for (const x of baseline) {
      const key = `${x.league}|${x.market}`
      const arr = leagueGroups.get(key) ?? []
      arr.push(x)
      leagueGroups.set(key, arr)
    }
    const byLeague = [...leagueGroups.entries()].map(([key, list]) => {
      const [league, market] = key.split('|')
      return { league, market, ...stat(list) }
    }).sort((a,b) => (b.n >= 20 ? b.wilsonLow : -1) - (a.n >= 20 ? a.wilsonLow : -1))

    const calibration = [[0,59],[60,69],[70,79],[80,89],[90,100]].map(([lo,hi]) => ({ band:`${lo}-${hi}`, ...stat(evaluated.filter((x) => x.dataQuality >= 70 && x.confidence >= lo && x.confidence <= hi)) }))
    const h2hAblation = {
      baseline: stat(evaluated.filter((x) => x.dataQuality >= 70 && x.confidence >= 78)),
      withoutH2H: stat(evaluated.filter((x) => x.dataQuality >= 70 && x.confidenceNoH2H >= 78)),
    }
    const cardRows = evaluated.filter((x) => x.market === 'cards' && x.dataQuality >= 70)
    const refereeAblation = {
      baseline: stat(cardRows.filter((x) => x.confidence >= 78)),
      withoutReferee: stat(cardRows.filter((x) => (x.confidenceNoRef ?? 0) >= 78)),
    }
    const recommended: Record<string, any> = {}
    for (const market of ['cards','corners','goals'] as Market[]) {
      const options = thresholds.map((threshold) => ({ threshold, ...stat(evaluated.filter((x) => x.market === market && x.dataQuality >= 70 && x.confidence >= threshold)) })).filter((x) => x.n >= 50)
      recommended[market] = options.sort((a,b) => b.wilsonLow - a.wilsonLow)[0] ?? null
    }

    const summary = {
      ok: true,
      model: 'v0-research-walk-forward',
      targetSeason: '2025/26',
      historyStart: HISTORY_START.slice(0,10),
      methodology: 'Walk-forward only: every fixture uses prior matches only; referee profile is rebuilt from prior appointments only.',
      targetFixtures,
      skippedLowHistory,
      evaluatedCandidates: evaluated.length,
      baselineAorBetter: stat(baseline),
      thresholds: thresholdSummary,
      bySelection,
      strongestLeagueMarkets: byLeague.slice(0,30),
      calibration,
      ablation: { h2h: h2hAblation, refereeCards: refereeAblation },
      exploratoryRecommendedThresholds: recommended,
      caveat: 'Hit-rate calibration only. Betting edge/profitability cannot be established until bookmaker odds are recorded and tested.',
    }

    await supabase.from('source_sync_runs').update({ finished_at: new Date().toISOString(), status: 'success', rows_upserted: evaluated.length, error_message: JSON.stringify(summary) }).eq('id', run.id)
    return new Response(JSON.stringify(summary), { headers: { 'content-type': 'application/json' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await supabase.from('source_sync_runs').update({ finished_at: new Date().toISOString(), status: 'failed', error_message: message }).eq('id', run.id)
    return new Response(JSON.stringify({ ok:false, error:message }), { status:500, headers:{ 'content-type':'application/json' } })
  }
}
