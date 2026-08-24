import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const SOURCE = 'fotmob'

const TARGETS = [
  { ccode: 'ENG', slug: 'premier-league', names: ['premier league'] },
  { ccode: 'ENG', slug: 'championship', names: ['championship'] },
  { ccode: 'SCO', slug: 'scottish-premiership', names: ['premiership', 'scottish premiership'] },
  { ccode: 'GER', slug: 'bundesliga', names: ['bundesliga'] },
  { ccode: 'ITA', slug: 'serie-a', names: ['serie a'] },
  { ccode: 'ESP', slug: 'la-liga', names: ['laliga', 'la liga'] },
  { ccode: 'FRA', slug: 'ligue-1', names: ['ligue 1'] },
  { ccode: 'NED', slug: 'eredivisie', names: ['eredivisie'] },
  { ccode: 'BEL', slug: 'belgian-pro-league', names: ['pro league', 'belgian pro league', 'jupiler pro league'] },
  { ccode: 'POR', slug: 'primeira-liga', names: ['liga portugal', 'primeira liga'] },
  { ccode: 'TUR', slug: 'super-lig', names: ['super lig', 'super lig'] },
] as const

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function clean(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function teamKey(value: string) {
  let s = clean(value)
  const replacements: Array<[RegExp, string]> = [
    [/\bmanchester\b/g, 'man'],
    [/\bunited\b/g, 'utd'],
    [/\bnottingham\b/g, 'nottm'],
    [/\bwolverhampton wanderers\b/g, 'wolves'],
    [/\bwolverhampton\b/g, 'wolves'],
    [/\bparis saint germain\b/g, 'psg'],
    [/\bparis sg\b/g, 'psg'],
    [/\binternazionale\b/g, 'inter'],
    [/\binter milan\b/g, 'inter'],
    [/\batletico madrid\b/g, 'ath madrid'],
    [/\bathletic club\b/g, 'ath bilbao'],
    [/\bborussia monchengladbach\b/g, 'm gladbach'],
    [/\b1 fc koln\b/g, 'fc koln'],
  ]
  for (const [pattern, replacement] of replacements) s = s.replace(pattern, replacement)
  s = s
    .split(' ')
    .filter((token) => !['fc', 'afc', 'cf', 'club', 'calcio', 'football'].includes(token))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s
}

function similarity(a: string, b: string) {
  if (a === b) return 1
  if (!a || !b) return 0
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length)
  const aa = new Set(a.split(' '))
  const bb = new Set(b.split(' '))
  const intersection = [...aa].filter((token) => bb.has(token)).length
  const union = new Set([...aa, ...bb]).size
  return union ? intersection / union : 0
}

function leagueTarget(league: any) {
  const ccode = String(league?.ccode ?? '').toUpperCase()
  const name = clean(String(league?.name ?? ''))
  return TARGETS.find((target) => target.ccode === ccode && target.names.some((alias) => name === clean(alias)))
}

function ymd(date: Date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`
}

async function fetchMatches(date: string) {
  const urls = [
    `https://www.fotmob.com/api/matches?date=${date}`,
    `https://www.fotmob.com/api/data/matches?date=${date}&timezone=Europe%2FLondon&ccode3=GBR`,
  ]
  let lastError = 'FotMob request failed'
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: 'application/json,text/plain,*/*',
          'user-agent': 'Mozilla/5.0 EVE-Football-Scanner/0.1',
        },
      })
      if (!response.ok) {
        lastError = `${response.status} ${response.statusText}`
        continue
      }
      const body = await response.json()
      if (Array.isArray(body?.leagues)) return body
      lastError = 'Unexpected FotMob response shape'
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as any },
  })

  const { data: countries, error: countryError } = await supabase.from('countries').select('id,code')
  if (countryError) throw countryError
  const countryIds = new Map((countries ?? []).map((row: any) => [row.code, row.id]))

  const { data: leagueRows, error: leagueError } = await supabase.from('leagues').select('id,slug').in('slug', TARGETS.map((x) => x.slug))
  if (leagueError) throw leagueError
  const leagueIds = new Map((leagueRows ?? []).map((row: any) => [row.slug, row.id]))

  const { data: teamRows, error: teamError } = await supabase.from('teams').select('id,name,country_id,source_key')
  if (teamError) throw teamError
  const teamsByCountry = new Map<string, any[]>()
  for (const row of teamRows ?? []) {
    if (!row.country_id) continue
    const list = teamsByCountry.get(row.country_id) ?? []
    list.push(row)
    teamsByCountry.set(row.country_id, list)
  }

  const resolvedCache = new Map<string, string>()
  const unmatched: string[] = []

  async function resolveTeam(target: (typeof TARGETS)[number], fotmobTeam: any) {
    const cacheKey = `${target.ccode}:${fotmobTeam.id}`
    if (resolvedCache.has(cacheKey)) return resolvedCache.get(cacheKey)!
    const countryId = countryIds.get(target.ccode)
    if (!countryId) throw new Error(`Country ${target.ccode} is missing`)
    const candidates = teamsByCountry.get(countryId) ?? []
    const wanted = teamKey(String(fotmobTeam.name ?? ''))
    let best: any = null
    let bestScore = 0
    for (const candidate of candidates) {
      const score = similarity(wanted, teamKey(candidate.name))
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    if (best && bestScore >= 0.62) {
      resolvedCache.set(cacheKey, best.id)
      return best.id as string
    }

    const sourceKey = `fotmob:${fotmobTeam.id}`
    const { data: existing } = await supabase.from('teams').select('id').eq('source_key', sourceKey).maybeSingle()
    if (existing?.id) {
      resolvedCache.set(cacheKey, existing.id)
      return existing.id as string
    }
    const { data: created, error } = await supabase.from('teams').insert({
      source_key: sourceKey,
      name: String(fotmobTeam.name),
      short_name: String(fotmobTeam.name),
      country_id: countryId,
    }).select('id,name,country_id,source_key').single()
    if (error) throw error
    const list = teamsByCountry.get(countryId) ?? []
    list.push(created)
    teamsByCountry.set(countryId, list)
    unmatched.push(`${target.slug}:${fotmobTeam.name}`)
    resolvedCache.set(cacheKey, created.id)
    return created.id as string
  }

  const now = new Date()
  const fixtures: any[] = []
  const seen = new Set<string>()
  const perLeague: Record<string, number> = {}
  const sourceErrors: string[] = []

  for (let offset = 0; offset < 8; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
    try {
      const payload = await fetchMatches(ymd(date))
      for (const league of payload.leagues ?? []) {
        const target = leagueTarget(league)
        if (!target) continue
        const leagueId = leagueIds.get(target.slug)
        if (!leagueId) continue
        for (const match of league.matches ?? []) {
          if (match?.status?.finished || match?.status?.cancelled) continue
          const kickoff = match?.status?.utcTime
            ? new Date(match.status.utcTime)
            : match?.timeTS
              ? new Date(Number(match.timeTS))
              : null
          if (!kickoff || Number.isNaN(kickoff.getTime()) || kickoff < now) continue
          const sourceFixtureId = String(match.id)
          const unique = `${SOURCE}:${sourceFixtureId}`
          if (seen.has(unique)) continue
          const homeTeamId = await resolveTeam(target, match.home)
          const awayTeamId = await resolveTeam(target, match.away)
          if (homeTeamId === awayTeamId) continue
          fixtures.push({
            source: SOURCE,
            source_fixture_id: sourceFixtureId,
            league_id: leagueId,
            home_team_id: homeTeamId,
            away_team_id: awayTeamId,
            kickoff: kickoff.toISOString(),
            status: 'scheduled',
            match_context: {
              fotmob_match_id: match.id,
              fotmob_league_id: match.leagueId ?? league.id ?? league.primaryId ?? null,
              fotmob_home_team_id: match.home?.id ?? null,
              fotmob_away_team_id: match.away?.id ?? null,
            },
            updated_at: new Date().toISOString(),
          })
          seen.add(unique)
          perLeague[target.slug] = (perLeague[target.slug] ?? 0) + 1
        }
      }
    } catch (error) {
      sourceErrors.push(`${ymd(date)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  if (fixtures.length) {
    const { error } = await supabase.from('fixtures').upsert(fixtures, { onConflict: 'source,source_fixture_id' })
    if (error) throw error
  }

  return new Response(JSON.stringify({
    ok: true,
    source: SOURCE,
    fixtures: fixtures.length,
    perLeague,
    unmatchedTeams: unmatched,
    sourceErrors,
  }), { headers: { 'content-type': 'application/json' } })
}
