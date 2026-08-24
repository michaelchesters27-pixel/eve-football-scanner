import { createClient } from '@supabase/supabase-js'
import {
  LEAGUES,
  historicalCsvUrl,
  parseCsv,
  previousSeasonCodes,
  safeNumber,
  sourceFixtureId,
  ukDateTimeToIso,
  type FootballDataRow,
  type LeagueConfig,
} from './_shared/footballData'

const SOURCE = 'football-data'

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function teamSourceKey(league: LeagueConfig, team: string) {
  return `${SOURCE}:${league.countryCode}:${slug(team)}`
}

function refereeSourceKey(name: string) {
  return `${SOURCE}:ref:${slug(name)}`
}

async function getCsv(url: string) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'EVE-Football-Scanner/0.1 (historical backfill)' },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return parseCsv(await response.text())
}

async function backfillLeague(
  supabase: ReturnType<typeof createClient>,
  league: LeagueConfig,
  rows: FootballDataRow[],
) {
  const { data: country, error: countryError } = await supabase
    .from('countries')
    .upsert({ code: league.countryCode, name: league.country }, { onConflict: 'code' })
    .select('id')
    .single()
  if (countryError) throw countryError

  const { data: leagueRow, error: leagueError } = await supabase
    .from('leagues')
    .upsert({ country_id: country.id, name: league.league, slug: league.slug, active: true }, { onConflict: 'slug' })
    .select('id')
    .single()
  if (leagueError) throw leagueError

  const finished = rows.filter((row) => row.Date && row.HomeTeam && row.AwayTeam && safeNumber(row.FTHG) != null && safeNumber(row.FTAG) != null)
  const teamNames = [...new Set(finished.flatMap((row) => [row.HomeTeam, row.AwayTeam]).filter(Boolean))]
  const teamsToUpsert = teamNames.map((name) => ({
    source_key: teamSourceKey(league, name),
    name,
    short_name: name,
    country_id: country.id,
  }))
  if (teamsToUpsert.length) {
    const { error } = await supabase.from('teams').upsert(teamsToUpsert, { onConflict: 'source_key' })
    if (error) throw error
  }

  const { data: teams, error: teamsError } = teamsToUpsert.length
    ? await supabase.from('teams').select('id,source_key').in('source_key', teamsToUpsert.map((team) => team.source_key))
    : { data: [], error: null }
  if (teamsError) throw teamsError
  const teamId = new Map((teams ?? []).map((team: any) => [team.source_key, team.id]))

  const refereeNames = [...new Set(finished.map((row) => row.Referee).filter(Boolean))]
  const refsToUpsert = refereeNames.map((name) => ({
    source_key: refereeSourceKey(name),
    name,
    country_id: country.id,
  }))
  if (refsToUpsert.length) {
    const { error } = await supabase.from('referees').upsert(refsToUpsert, { onConflict: 'source_key' })
    if (error) throw error
  }

  const { data: refs, error: refsError } = refsToUpsert.length
    ? await supabase.from('referees').select('id,source_key').in('source_key', refsToUpsert.map((ref) => ref.source_key))
    : { data: [], error: null }
  if (refsError) throw refsError
  const refereeId = new Map((refs ?? []).map((ref: any) => [ref.source_key, ref.id]))

  const fixtures = finished.map((row) => {
    const home = teamId.get(teamSourceKey(league, row.HomeTeam))
    const away = teamId.get(teamSourceKey(league, row.AwayTeam))
    const kickoff = ukDateTimeToIso(row.Date, row.Time || '12:00')
    if (!home || !away || !kickoff) return null
    const key = sourceFixtureId(league.div, row.Date, row.HomeTeam, row.AwayTeam)
    return {
      source: SOURCE,
      source_fixture_id: key,
      league_id: leagueRow.id,
      home_team_id: home,
      away_team_id: away,
      referee_id: row.Referee ? refereeId.get(refereeSourceKey(row.Referee)) ?? null : null,
      kickoff,
      status: 'finished',
      home_goals: safeNumber(row.FTHG),
      away_goals: safeNumber(row.FTAG),
      half_time_home_goals: safeNumber(row.HTHG),
      half_time_away_goals: safeNumber(row.HTAG),
      updated_at: new Date().toISOString(),
    }
  }).filter(Boolean) as any[]

  if (!fixtures.length) return { fixtures: 0, stats: 0 }

  const { data: savedFixtures, error: fixtureError } = await supabase
    .from('fixtures')
    .upsert(fixtures, { onConflict: 'source,source_fixture_id' })
    .select('id,source_fixture_id')
  if (fixtureError) throw fixtureError
  const fixtureId = new Map((savedFixtures ?? []).map((fixture: any) => [fixture.source_fixture_id, fixture.id]))

  const stats: any[] = []
  for (const row of finished) {
    const key = sourceFixtureId(league.div, row.Date, row.HomeTeam, row.AwayTeam)
    const id = fixtureId.get(key)
    const home = teamId.get(teamSourceKey(league, row.HomeTeam))
    const away = teamId.get(teamSourceKey(league, row.AwayTeam))
    if (!id || !home || !away) continue
    stats.push({ fixture_id: id, team_id: home, venue: 'home', goals: safeNumber(row.FTHG), yellow_cards: safeNumber(row.HY), red_cards: safeNumber(row.HR), corners: safeNumber(row.HC), fouls: safeNumber(row.HF), shots: safeNumber(row.HS), shots_on_target: safeNumber(row.HST), source: SOURCE })
    stats.push({ fixture_id: id, team_id: away, venue: 'away', goals: safeNumber(row.FTAG), yellow_cards: safeNumber(row.AY), red_cards: safeNumber(row.AR), corners: safeNumber(row.AC), fouls: safeNumber(row.AF), shots: safeNumber(row.AS), shots_on_target: safeNumber(row.AST), source: SOURCE })
  }
  if (stats.length) {
    const { error } = await supabase.from('team_match_stats').upsert(stats, { onConflict: 'fixture_id,team_id' })
    if (error) throw error
  }

  return { fixtures: fixtures.length, stats: stats.length }
}

export default async (request: Request) => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const url = new URL(request.url)
  const season = url.searchParams.get('season') || previousSeasonCodes(4)[1]
  const div = url.searchParams.get('div')
  const targets = div ? LEAGUES.filter((league) => league.div === div) : LEAGUES
  if (!targets.length) return new Response(JSON.stringify({ ok: false, error: `Unknown div: ${div}` }), { status: 400 })

  const details: any[] = []
  let total = 0
  for (const league of targets) {
    try {
      const rows = await getCsv(historicalCsvUrl(season, league.div))
      const result = await backfillLeague(supabase, league, rows)
      total += result.fixtures + result.stats
      details.push({ league: league.slug, ...result })
    } catch (error) {
      details.push({ league: league.slug, error: error instanceof Error ? error.message : String(error) })
    }
  }

  await supabase.rpc('refresh_referee_profiles')

  return new Response(JSON.stringify({ ok: true, season, rows: total, details }), {
    headers: { 'content-type': 'application/json' },
  })
}
