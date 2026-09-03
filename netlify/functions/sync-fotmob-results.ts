import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '10 5 * * *' }

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function ymd(date: Date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,'0')}${String(date.getUTCDate()).padStart(2,'0')}`
}
function norm(value: unknown) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}
function numberValue(value: unknown): number | null {
  const raw = typeof value === 'object' && value
    ? (value as any).value ?? (value as any).stat ?? (value as any).total
    : value
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const parsed = Number.parseFloat(raw.replace(/,/g, '').replace(/%/g, '').trim())
  return Number.isFinite(parsed) ? parsed : null
}
function pairValue(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const home = numberValue(value[0])
    const away = numberValue(value[1])
    return home != null && away != null ? [home, away] : null
  }
  if (!value || typeof value !== 'object') return null
  const node = value as any
  const home = numberValue(node.home ?? node.homeValue ?? node.homeStat)
  const away = numberValue(node.away ?? node.awayValue ?? node.awayStat)
  if (home != null && away != null) return [home, away]
  for (const key of ['stats', 'values', 'value', 'data']) {
    const pair = pairValue(node[key])
    if (pair) return pair
  }
  return null
}
function findPair(node: unknown, aliases: string[]): [number, number] | null {
  const wanted = aliases.map(norm)
  const matches = (value: unknown) => {
    const key = norm(value)
    return key.length > 0 && wanted.some((alias) => key === alias || key.includes(alias) || alias.includes(key))
  }
  const visit = (value: unknown, depth: number): [number, number] | null => {
    if (!value || depth > 12) return null
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1)
        if (found) return found
      }
      return null
    }
    if (typeof value !== 'object') return null
    const object = value as Record<string, unknown>
    const label = object.title ?? object.name ?? object.key ?? object.label ?? object.statName ?? object.type
    if (matches(label)) {
      const direct = pairValue(object)
      if (direct) return direct
    }
    for (const [key, child] of Object.entries(object)) {
      if (matches(key)) {
        const direct = pairValue(child)
        if (direct) return direct
      }
    }
    for (const child of Object.values(object)) {
      if (child && typeof child === 'object') {
        const found = visit(child, depth + 1)
        if (found) return found
      }
    }
    return null
  }
  return visit(node, 0)
}
function matchEvents(payload: any): any[] {
  const candidates = [
    payload?.content?.matchFacts?.events?.events,
    payload?.content?.matchFacts?.events,
    payload?.header?.events,
  ]
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate
  return []
}
function minuteOf(event: any): number | null {
  const raw = event?.time ?? event?.minute ?? event?.min
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  const match = String(raw ?? '').match(/\d+/)
  return match ? Number(match[0]) : null
}
function halftimeFromEvents(payload: any, finalHome: number | null, finalAway: number | null): [number, number] | null {
  const explicit = findPair(payload, ['half time score', 'halftime score', 'half-time score'])
  if (explicit) return [Math.round(explicit[0]), Math.round(explicit[1])]

  const events = matchEvents(payload)
  let latest: { minute: number; home: number; away: number } | null = null
  let scoreEventSeen = false
  for (const event of events) {
    const home = numberValue(event?.homeScore ?? event?.home_score)
    const away = numberValue(event?.awayScore ?? event?.away_score)
    if (home == null || away == null) continue
    scoreEventSeen = true
    const minute = minuteOf(event)
    if (minute == null || minute > 45) continue
    if (!latest || minute >= latest.minute) latest = { minute, home, away }
  }
  if (latest) return [Math.round(latest.home), Math.round(latest.away)]
  if (finalHome === 0 && finalAway === 0) return [0, 0]
  if (events.length && scoreEventSeen) return [0, 0]
  return null
}
async function fetchMatches(date: string) {
  const urls = [
    `https://www.fotmob.com/api/matches?date=${date}`,
    `https://www.fotmob.com/api/data/matches?date=${date}&timezone=Europe%2FLondon&ccode3=GBR`,
  ]
  let last = 'FotMob request failed'
  for (const url of urls) {
    try {
      const response = await fetch(url,{ headers:{ accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.6' } })
      if (!response.ok) { last = `${response.status} ${response.statusText}`; continue }
      const body = await response.json()
      if (Array.isArray(body?.leagues)) return body
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
  }
  throw new Error(last)
}
async function fetchDetails(matchId: string) {
  const urls = [
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ]
  let last = 'FotMob matchDetails failed'
  for (const url of urls) {
    try {
      const response = await fetch(url,{ headers:{ accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.6' } })
      if (!response.ok) { last = `${response.status} ${response.statusText}`; continue }
      const body = await response.json()
      if (body?.content || body?.general || body?.header) return body
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
  }
  throw new Error(last)
}

type TeamStatPairs = {
  yellow_cards: [number, number] | null
  red_cards: [number, number] | null
  corners: [number, number] | null
  fouls: [number, number] | null
  shots: [number, number] | null
  shots_on_target: [number, number] | null
  xg: [number, number] | null
  possession: [number, number] | null
}
function detailStats(payload: any): TeamStatPairs {
  return {
    yellow_cards: findPair(payload, ['yellow cards', 'yellow card']),
    red_cards: findPair(payload, ['red cards', 'red card']),
    corners: findPair(payload, ['corners', 'corner kicks']),
    fouls: findPair(payload, ['fouls committed', 'fouls']),
    shots: findPair(payload, ['total shots', 'shots']),
    shots_on_target: findPair(payload, ['shots on target', 'shotsontarget']),
    xg: findPair(payload, ['expected goals', 'xg']),
    possession: findPair(payload, ['ball possession', 'possession']),
  }
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{ auth:{ persistSession:false,autoRefreshToken:false } })
  const now = new Date()
  let updated = 0
  let detailsChecked = 0
  let detailsUpdated = 0
  let statsRowsWritten = 0
  const errors: string[] = []
  const detailWarnings: string[] = []

  for (const offset of [-2,-1,0]) {
    const date = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+offset))
    try {
      const payload = await fetchMatches(ymd(date))
      for (const league of payload.leagues ?? []) {
        for (const match of league.matches ?? []) {
          const id = String(match?.id ?? '')
          if (!id) continue
          const finished = Boolean(match?.status?.finished)
          const cancelled = Boolean(match?.status?.cancelled)
          const started = Boolean(match?.status?.started)
          const status = cancelled ? 'cancelled' : finished ? 'finished' : started ? 'live' : 'scheduled'
          const homeScore = Number.isFinite(Number(match?.home?.score)) ? Number(match.home.score) : null
          const awayScore = Number.isFinite(Number(match?.away?.score)) ? Number(match.away.score) : null
          const patch: any = { status, updated_at:new Date().toISOString() }
          if (homeScore != null) patch.home_goals = homeScore
          if (awayScore != null) patch.away_goals = awayScore
          const { data,error } = await supabase.from('fixtures')
            .update(patch)
            .eq('source','fotmob')
            .eq('source_fixture_id',id)
            .select('id,home_team_id,away_team_id,home_goals,away_goals')
            .maybeSingle()
          if (error) { errors.push(`${id}: ${error.message}`); continue }
          if (!data?.id) continue
          updated += 1
          if (!finished) continue

          detailsChecked += 1
          let details: any
          try {
            details = await fetchDetails(id)
          } catch (error) {
            detailWarnings.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
            continue
          }

          const finalHome = homeScore ?? numberValue(data.home_goals)
          const finalAway = awayScore ?? numberValue(data.away_goals)
          const ht = halftimeFromEvents(details, finalHome, finalAway)
          if (ht) {
            const { error: htError } = await supabase.from('fixtures').update({
              half_time_home_goals: ht[0],
              half_time_away_goals: ht[1],
              updated_at: new Date().toISOString(),
            }).eq('id', data.id)
            if (htError) errors.push(`${id}: half-time update: ${htError.message}`)
          }

          const pairs = detailStats(details)
          const rows = [
            { teamId: data.home_team_id, venue: 'home', side: 0 as const, goals: finalHome },
            { teamId: data.away_team_id, venue: 'away', side: 1 as const, goals: finalAway },
          ]
          let wroteForFixture = false
          for (const row of rows) {
            if (!row.teamId) continue
            const statRow: Record<string, unknown> = {
              fixture_id: data.id,
              team_id: row.teamId,
              venue: row.venue,
              goals: row.goals,
              source: 'fotmob-match-details',
            }
            for (const [field, pair] of Object.entries(pairs)) {
              if (pair) statRow[field] = pair[row.side]
            }
            const { error: statsError } = await supabase.from('team_match_stats').upsert(statRow, { onConflict:'fixture_id,team_id' })
            if (statsError) {
              errors.push(`${id}: ${row.venue} stats: ${statsError.message}`)
            } else {
              statsRowsWritten += 1
              wroteForFixture = true
            }
          }
          if (wroteForFixture) detailsUpdated += 1
          await new Promise((resolve) => setTimeout(resolve, 120))
        }
      }
    } catch (error) {
      errors.push(`${ymd(date)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return new Response(JSON.stringify({
    ok:true,
    source:'fotmob',
    updated,
    detailsChecked,
    detailsUpdated,
    statsRowsWritten,
    errors,
    detailWarnings: detailWarnings.slice(0,30),
  }),{ headers:{ 'content-type':'application/json' } })
}
