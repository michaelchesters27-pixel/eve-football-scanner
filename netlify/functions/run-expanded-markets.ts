import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '45 5 * * *' }

type Market = 'btts' | 'team_goals' | 'half_goals' | 'match_cards' | 'match_corners'
type MatchRow = {
  fixture_id: string
  kickoff: string
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

type PlayerOutlook = {
  teamId: string
  name?: string | null
  position?: string | null
  matchesSample: number | null
  avgMinutes: number | null
  avgShots: number | null
  avgShotsOnTarget: number | null
  avgGoals: number | null
  avgYellowCards: number | null
}

const MODEL = 'v1-expanded-research'

const WEIGHTS: Record<Market, Record<string, number>> = {
  btts: { recent: .20, venue: .30, opponent: .18, season: .14, h2h: .08, lineup: .10 },
  team_goals: { recent: .20, venue: .32, opponent: .22, season: .14, h2h: .05, lineup: .07 },
  half_goals: { recent: .22, venue: .30, opponent: .18, season: .17, h2h: .08, lineup: .05 },
  match_cards: { recent: .18, venue: .25, opponent: .15, season: .12, h2h: .07, referee: .18, lineup: .05 },
  match_corners: { recent: .22, venue: .32, opponent: .18, season: .18, h2h: .06, lineup: .04 },
}

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function clamp(value: number, min = 0, max = 100) { return Math.max(min, Math.min(max, value)) }
function recent(rows: MatchRow[], count: number) {
  return [...rows].sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff)).slice(0, count)
}
function pct(rows: MatchRow[], test: (row: MatchRow) => boolean) {
  if (!rows.length) return 0
  return rows.filter(test).length / rows.length * 100
}
function mean(values: Array<number | null | undefined>) {
  const clean = values.map(Number).filter((n) => Number.isFinite(n))
  return clean.length ? clean.reduce((a, b) => a + b, 0) / clean.length : 0
}
function matchGoals(row: MatchRow) { return (row.home_goals ?? 0) + (row.away_goals ?? 0) }
function firstHalfGoals(row: MatchRow) { return (row.half_time_home_goals ?? 0) + (row.half_time_away_goals ?? 0) }
function totalCards(row: MatchRow) { return (row.yellow_cards ?? 0) + (row.opponent_yellow_cards ?? 0) }
function totalCorners(row: MatchRow) { return (row.corners ?? 0) + (row.opponent_corners ?? 0) }
function btts(row: MatchRow) { return (row.goals ?? 0) > 0 && (row.opponent_goals ?? 0) > 0 }
function grade(score: number): Candidate['grade'] {
  if (score >= 84) return 'A+'
  if (score >= 78) return 'A'
  if (score >= 70) return 'B'
  return 'C'
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
function sampleQuality(parts: Array<[number, number, number]>) {
  const sumWeight = parts.reduce((sum, [, , w]) => sum + w, 0)
  if (!sumWeight) return 0
  return Math.round(parts.reduce((sum, [actual, target, w]) => sum + clamp(actual / target, 0, 1) * w, 0) / sumWeight * 100)
}
function rate(value: number) { return `${Math.round(value)}% hit` }
function round1(value:number){ return Math.round(value*10)/10 }
function per90(value:number|null|undefined,minutes:number|null|undefined){
  const v=Number(value??0),m=Number(minutes??0)
  if(!Number.isFinite(v)||!Number.isFinite(m)||m<15) return 0
  return v*90/m
}
function shrinkToNeutral(raw:number,reliability:number,maxDistance=16){
  const capped=clamp(raw,50-maxDistance,50+maxDistance)
  return 50+(capped-50)*clamp(reliability,0,100)/100
}

function lineupContext(players: PlayerOutlook[], homeTeamId: string, awayTeamId: string, explicitlyConfirmed:boolean) {
  const allHome=players.filter((p)=>p.teamId===homeTeamId)
  const allAway=players.filter((p)=>p.teamId===awayTeamId)
  const withHistory=players.filter((p)=>Number(p.matchesSample??0)>0)
  const reliable=withHistory.filter((p)=>Number(p.matchesSample??0)>=3 && Number(p.avgMinutes??0)>=30)
  const homeReliable=reliable.filter((p)=>p.teamId===homeTeamId)
  const awayReliable=reliable.filter((p)=>p.teamId===awayTeamId)
  const confirmed=explicitlyConfirmed && allHome.length>=11 && allAway.length>=11

  const sampleDepth=mean(players.map((p)=>Math.min(Number(p.matchesSample??0),8)/8))*100
  const coverage=(homeReliable.length+awayReliable.length)/22*100
  const reliability=confirmed ? clamp(coverage*.7+sampleDepth*.3) : 0
  const usable=confirmed && reliability>=25 && homeReliable.length>=4 && awayReliable.length>=4

  function scaledTeam(rows:PlayerOutlook[],field:'avgShots'|'avgShotsOnTarget'|'avgGoals'|'avgYellowCards'){
    if(!rows.length) return 0
    const observed=rows.map((p)=>per90(p[field],p.avgMinutes)).filter(Number.isFinite)
    return observed.length ? observed.reduce((a,b)=>a+b,0)/observed.length*11 : 0
  }

  const homeShots90=scaledTeam(homeReliable,'avgShots')
  const awayShots90=scaledTeam(awayReliable,'avgShots')
  const homeSot90=scaledTeam(homeReliable,'avgShotsOnTarget')
  const awaySot90=scaledTeam(awayReliable,'avgShotsOnTarget')
  const homeGoals90=scaledTeam(homeReliable,'avgGoals')
  const awayGoals90=scaledTeam(awayReliable,'avgGoals')
  const homeCards90=scaledTeam(homeReliable,'avgYellowCards')
  const awayCards90=scaledTeam(awayReliable,'avgYellowCards')

  const rawHomeGoal=50+(homeSot90-4.5)*4.0+(homeShots90-12)*0.8+(homeGoals90-1.35)*5
  const rawAwayGoal=50+(awaySot90-4.0)*4.0+(awayShots90-11)*0.8+(awayGoals90-1.15)*5
  const rawJointGoal=50+((homeSot90+awaySot90)-8.5)*2.1+((homeGoals90+awayGoals90)-2.5)*3
  const rawCorner=50+((homeShots90+awayShots90)-23)*0.85+((homeSot90+awaySot90)-8.5)*0.65
  const rawCards=50+((homeCards90+awayCards90)-4)*5.5

  const factor=usable?reliability:0
  const homeGoalScore=shrinkToNeutral(rawHomeGoal,factor)
  const awayGoalScore=shrinkToNeutral(rawAwayGoal,factor)
  const goalScore=shrinkToNeutral(rawJointGoal,factor)
  const cornerScore=shrinkToNeutral(rawCorner,factor)
  const cardScore=shrinkToNeutral(rawCards,factor)

  const topAttackers=[...reliable].map((p)=>({
    name:p.name??'Unknown',teamId:p.teamId,matches:Number(p.matchesSample??0),
    sot90:round1(per90(p.avgShotsOnTarget,p.avgMinutes)),
    goals90:round1(per90(p.avgGoals,p.avgMinutes)),
  })).sort((a,b)=>(b.sot90+b.goals90*1.5)-(a.sot90+a.goals90*1.5)).slice(0,5)
  const cardRisks=[...reliable].map((p)=>({
    name:p.name??'Unknown',teamId:p.teamId,matches:Number(p.matchesSample??0),cards90:round1(per90(p.avgYellowCards,p.avgMinutes)),
  })).sort((a,b)=>b.cards90-a.cards90).slice(0,5)

  return {
    confirmed,
    usable,
    startersEntered:{home:allHome.length,away:allAway.length},
    historyPlayers:withHistory.length,
    reliablePlayers:reliable.length,
    homeReliablePlayers:homeReliable.length,
    awayReliablePlayers:awayReliable.length,
    historyCoveragePct:round1(coverage),
    sampleDepthPct:round1(sampleDepth),
    reliabilityPct:round1(reliability),
    homeShots90:round1(homeShots90),awayShots90:round1(awayShots90),
    homeSot90:round1(homeSot90),awaySot90:round1(awaySot90),
    homeGoals90:round1(homeGoals90),awayGoals90:round1(awayGoals90),
    homeCards90:round1(homeCards90),awayCards90:round1(awayCards90),
    totalShots90:round1(homeShots90+awayShots90),totalSot90:round1(homeSot90+awaySot90),
    goalScore:round1(goalScore),homeGoalScore:round1(homeGoalScore),awayGoalScore:round1(awayGoalScore),
    cornerScore:round1(cornerScore),cardScore:round1(cardScore),
    topAttackers,cardRisks,
    calibrationNote:'Starting-XI influence is a small reliability-shrunk match-day refinement. It is not allowed to masquerade as a separately backtested player edge.',
  }
}

function jointMatchCandidate(
  fixtureId: string,
  market: 'btts' | 'half_goals' | 'match_cards' | 'match_corners',
  selectionKey: string,
  selection: string,
  homeRows: MatchRow[],
  awayRows: MatchRow[],
  awayId: string,
  tester: (row: MatchRow) => boolean,
  lineup: ReturnType<typeof lineupContext>,
  referee: { yellow_cards_per_match?: number | null; matches_sample?: number | null } | null,
): Candidate {
  const home10 = recent(homeRows, 10)
  const away10 = recent(awayRows, 10)
  const homeVenue = recent(homeRows.filter((r) => r.venue === 'home'), 10)
  const awayVenue = recent(awayRows.filter((r) => r.venue === 'away'), 10)
  const homeSeason = recent(homeRows, 30)
  const awaySeason = recent(awayRows, 30)
  const h2h = recent(homeRows.filter((r) => r.opponent_team_id === awayId), 5)

  const recentRate = (pct(home10, tester) + pct(away10, tester)) / 2
  const venueRate = (pct(homeVenue, tester) + pct(awayVenue, tester)) / 2
  const seasonRate = (pct(homeSeason, tester) + pct(awaySeason, tester)) / 2
  const h2hRate = pct(h2h, tester)
  const opponentRate = recentRate
  const refCards = Number(referee?.yellow_cards_per_match ?? 0)
  const refereeScore = referee ? clamp(40 + (refCards - 3) * 17) : 50
  const lineupScore = market === 'match_cards' ? lineup.cardScore : market === 'match_corners' ? lineup.cornerScore : lineup.goalScore

  const lineupSample=lineup.usable?Math.round(lineup.reliabilityPct/100*14):0
  const quality = sampleQuality([
    [home10.length + away10.length, 20, 22],
    [homeVenue.length + awayVenue.length, 20, 30],
    [homeSeason.length + awaySeason.length, 50, 18],
    [h2h.length, 4, 8],
    [lineupSample, 14, 10],
    [market === 'match_cards' ? Number(referee?.matches_sample ?? 0) : 10, 10, 12],
  ])
  const lineupDisplay=!lineup.confirmed?'Starting XI not confirmed':!lineup.usable?`XI confirmed · history thin (${lineup.reliablePlayers}/22 reliable)`:`XI confirmed · ${lineup.historyCoveragePct}% history coverage · ${lineup.totalSot90} SOT/90`
  const evidence: Evidence[] = [
    { key: 'recent', label: 'Recent 10 each', display: rate(recentRate), score: Math.round(recentRate) },
    { key: 'venue', label: 'Home vs away split', display: rate(venueRate), score: Math.round(venueRate) },
    { key: 'opponent', label: 'Opposition profile', display: rate(opponentRate), score: Math.round(opponentRate) },
    { key: 'season', label: 'Season sample', display: rate(seasonRate), score: Math.round(seasonRate) },
    { key: 'h2h', label: 'H2H', display: h2h.length ? rate(h2hRate) : 'No usable sample', score: h2h.length ? Math.round(h2hRate) : 50 },
    ...(market === 'match_cards' ? [{ key: 'referee', label: 'Referee', display: referee ? `${refCards.toFixed(1)} cards/match` : 'Not confirmed', score: Math.round(refereeScore) }] : []),
    { key: 'lineup', label: 'Starting XI intelligence', display: lineupDisplay, score: Math.round(lineupScore) },
  ]
  const confidence = score(market, evidence, quality)
  const neutralEvidence=evidence.map((e)=>e.key==='lineup'?{...e,score:50}:e)
  const baselineConfidence=score(market,neutralEvidence,quality)
  return {
    fixtureId, market, selectionKey, selection, confidence, grade: grade(confidence), dataQuality: quality, evidence,
    features: {
      recentRate, venueRate, seasonRate, h2hRate, lineup, refereeCards: refCards,
      lineupImpact:{baselineConfidence,refinedConfidence:confidence,delta:confidence-baselineConfidence},
      samples: { home: homeRows.length, away: awayRows.length, h2h: h2h.length },
    },
  }
}

function teamGoalCandidate(
  fixtureId: string,
  side: 'home' | 'away',
  threshold: 1 | 2,
  ownRows: MatchRow[],
  opponentRows: MatchRow[],
  opponentId: string,
  lineup: ReturnType<typeof lineupContext>,
): Candidate {
  const r10 = recent(ownRows, 10)
  const venue10 = recent(ownRows.filter((r) => r.venue === side), 10)
  const opp10 = recent(opponentRows.filter((r) => r.venue === (side === 'home' ? 'away' : 'home')), 10)
  const season = recent(ownRows, 30)
  const h2h = recent(ownRows.filter((r) => r.opponent_team_id === opponentId), 5)
  const ownTest = (r: MatchRow) => (r.goals ?? -1) >= threshold
  const concedeTest = (r: MatchRow) => (r.opponent_goals ?? -1) >= threshold
  const recentRate = pct(r10, ownTest)
  const venueRate = pct(venue10, ownTest)
  const opponentRate = pct(opp10, concedeTest)
  const seasonRate = pct(season, ownTest)
  const h2hRate = pct(h2h, ownTest)
  const lineupScore = side === 'home' ? lineup.homeGoalScore : lineup.awayGoalScore
  const lineupSample=lineup.usable?Math.round(lineup.reliabilityPct/100*14):0
  const quality = sampleQuality([[r10.length,10,20],[venue10.length,10,32],[opp10.length,10,22],[season.length,25,14],[h2h.length,4,5],[lineupSample,14,7]])
  const sideSot=side==='home'?lineup.homeSot90:lineup.awaySot90
  const lineupDisplay=!lineup.confirmed?'Starting XI not confirmed':!lineup.usable?`XI confirmed · history thin (${lineup.reliablePlayers}/22 reliable)`:`XI confirmed · ${sideSot} SOT/90 · reliability ${lineup.reliabilityPct}%`
  const evidence: Evidence[] = [
    { key: 'recent', label: 'Recent 10', display: rate(recentRate), score: Math.round(recentRate) },
    { key: 'venue', label: side === 'home' ? 'Home-only form' : 'Away-only form', display: rate(venueRate), score: Math.round(venueRate) },
    { key: 'opponent', label: 'Opponent concedes', display: rate(opponentRate), score: Math.round(opponentRate) },
    { key: 'season', label: 'Season sample', display: rate(seasonRate), score: Math.round(seasonRate) },
    { key: 'h2h', label: 'H2H', display: h2h.length ? rate(h2hRate) : 'No usable sample', score: h2h.length ? Math.round(h2hRate) : 50 },
    { key: 'lineup', label: 'Starting XI attack', display: lineupDisplay, score: Math.round(lineupScore) },
  ]
  const confidence = score('team_goals', evidence, quality)
  const neutralEvidence=evidence.map((e)=>e.key==='lineup'?{...e,score:50}:e)
  const baselineConfidence=score('team_goals',neutralEvidence,quality)
  return {
    fixtureId,
    market: 'team_goals',
    selectionKey: `${side}_goals_${threshold === 1 ? '0_5' : '1_5'}`,
    selection: `${side === 'home' ? 'Home' : 'Away'} Team — ${threshold}+ Goal${threshold === 1 ? '' : 's'}`,
    confidence, grade: grade(confidence), dataQuality: quality, evidence,
    features: {
      recentRate, venueRate, opponentRate, seasonRate, h2hRate, lineup, threshold, side,
      lineupImpact:{baselineConfidence,refinedConfidence:confidence,delta:confidence-baselineConfidence},
    },
  }
}

export default async (request?: Request) => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } })
  const now = new Date()
  const horizon = new Date(now.getTime() + 7 * 86400000)
  const requestedFixtureId = request ? new URL(request.url).searchParams.get('fixture_id') : null

  let fixtureQuery = supabase
    .from('fixtures')
    .select('id,kickoff,home_team_id,away_team_id,referee_id')
    .in('status', ['scheduled','live'])
    .gte('kickoff', now.toISOString())
    .lt('kickoff', horizon.toISOString())
    .order('kickoff')
  if (requestedFixtureId) fixtureQuery = fixtureQuery.eq('id', requestedFixtureId)
  const { data: fixtures, error: fixtureError } = await fixtureQuery
  if (fixtureError) return new Response(JSON.stringify({ ok: false, error: fixtureError.message }), { status: 500, headers: { 'content-type': 'application/json' } })

  let generated = 0
  let qualified = 0
  const marketCounts: Record<string, number> = {}
  const lineupSummaries:any[]=[]

  for (const fixture of fixtures ?? []) {
    const { data: history, error: historyError } = await supabase
      .from('team_match_flat')
      .select('*')
      .in('team_id', [fixture.home_team_id, fixture.away_team_id])
      .lt('kickoff', fixture.kickoff)
      .order('kickoff', { ascending: false })
      .limit(220)
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

    const {data:manualContext}=await supabase.from('manual_match_context').select('lineups_confirmed').eq('fixture_id',fixture.id).maybeSingle()
    let playerRows: PlayerOutlook[] = []
    const { data: outlook } = await supabase.from('fixture_player_outlook').select('teamId,name,position,matchesSample,avgMinutes,avgShots,avgShotsOnTarget,avgGoals,avgYellowCards').eq('fixtureId', fixture.id)
    if (outlook) playerRows = outlook as unknown as PlayerOutlook[]
    const lineup = lineupContext(playerRows, fixture.home_team_id, fixture.away_team_id, Boolean(manualContext?.lineups_confirmed))
    if(lineup.confirmed) lineupSummaries.push({fixtureId:fixture.id,reliabilityPct:lineup.reliabilityPct,historyCoveragePct:lineup.historyCoveragePct,reliablePlayers:lineup.reliablePlayers,totalSot90:lineup.totalSot90})

    const candidates: Candidate[] = [
      jointMatchCandidate(fixture.id, 'btts', 'btts_yes', 'Both Teams To Score — Yes', homeRows, awayRows, fixture.away_team_id, btts, lineup, referee),
      teamGoalCandidate(fixture.id, 'home', 1, homeRows, awayRows, fixture.away_team_id, lineup),
      teamGoalCandidate(fixture.id, 'away', 1, awayRows, homeRows, fixture.home_team_id, lineup),
      teamGoalCandidate(fixture.id, 'home', 2, homeRows, awayRows, fixture.away_team_id, lineup),
      teamGoalCandidate(fixture.id, 'away', 2, awayRows, homeRows, fixture.home_team_id, lineup),
      jointMatchCandidate(fixture.id, 'half_goals', 'first_half_0_5', 'First Half — Over 0.5 Goals', homeRows, awayRows, fixture.away_team_id, (r) => firstHalfGoals(r) >= 1, lineup, referee),
      jointMatchCandidate(fixture.id, 'match_cards', 'match_cards_3_5', 'Match — 4+ Yellow Cards', homeRows, awayRows, fixture.away_team_id, (r) => totalCards(r) >= 4, lineup, referee),
      jointMatchCandidate(fixture.id, 'match_corners', 'match_corners_8_5', 'Match — 9+ Corners', homeRows, awayRows, fixture.away_team_id, (r) => totalCorners(r) >= 9, lineup, referee),
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

      const publishStatus = candidate.confidence >= 65 && candidate.dataQuality >= 55 ? 'published' : 'suppressed'
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
        marketCounts[candidate.market] = (marketCounts[candidate.market] ?? 0) + 1
        if (publishStatus === 'published') qualified += 1
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    model: MODEL,
    fixtures: fixtures?.length ?? 0,
    generated,
    researchQualified: qualified,
    marketCounts,
    confirmedLineupIntelligence:lineupSummaries,
    note: 'Expanded markets remain calibrated research signals. Confirmed starting XIs now add a small reliability-shrunk player-history refinement using shots, shots on target, goals, cards and minutes; thin player samples stay neutral rather than creating a false edge.',
  }), { headers: { 'content-type': 'application/json' } })
}
