import { createClient } from '@supabase/supabase-js'
import ws from 'ws'
import {
  FIXTURES_CSV_URL,
  LEAGUES,
  currentSeasonCode,
  historicalCsvUrl,
  parseCsv,
  safeNumber,
  sourceFixtureId,
  ukDateTimeToIso,
  type FootballDataRow,
  type LeagueConfig,
} from './_shared/footballData'

export const config = { schedule: '15 5 * * *' }

const SOURCE = 'football-data'

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function getCsv(url: string) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'EVE-Football-Scanner/0.1 (free-data research sync)' },
  })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
  return parseCsv(await response.text())
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

async function syncLeague(
  supabase: ReturnType<typeof createClient>,
  league: LeagueConfig,
  resultRows: FootballDataRow[],
  fixtureRows: FootballDataRow[],
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

  const allRows = [...resultRows, ...fixtureRows]
  const teamNames = [...new Set(allRows.flatMap((row) => [row.HomeTeam, row.AwayTeam]).filter(Boolean))]
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

  const teamKeys = teamsToUpsert.map((team) => team.source_key)
  const { data: teams, error: teamsError } = teamKeys.length
    ? await supabase.from('teams').select('id,source_key,name').in('source_key', teamKeys)
    : { data: [], error: null }
  if (teamsError) throw teamsError
  const teamId = new Map((teams ?? []).map((team: any) => [team.source_key, team.id]))

  const refereeNames = [...new Set(resultRows.map((row) => row.Referee).filter(Boolean))]
  const refsToUpsert = refereeNames.map((name) => ({
    source_key: refereeSourceKey(name),
    name,
    country_id: country.id,
  }))
  if (refsToUpsert.length) {
    const { error } = await supabase.from('referees').upsert(refsToUpsert, { onConflict: 'source_key' })
    if (error) throw error
  }

  const refKeys = refsToUpsert.map((ref) => ref.source_key)
  const { data: refs, error: refsError } = refKeys.length
    ? await supabase.from('referees').select('id,source_key').in('source_key', refKeys)
    : { data: [], error: null }
  if (refsError) throw refsError
  const refereeId = new Map((refs ?? []).map((ref: any) => [ref.source_key, ref.id]))

  const fixtureMap = new Map<string, any>()

  for (const row of fixtureRows) {
    if (!row.Date || !row.HomeTeam || !row.AwayTeam) continue
    const kickoff = ukDateTimeToIso(row.Date, row.Time || '12:00')
    const home = teamId.get(teamSourceKey(league, row.HomeTeam))
    const away = teamId.get(teamSourceKey(league, row.AwayTeam))
    if (!kickoff || !home || !away) continue
    const key = sourceFixtureId(league.div, row.Date, row.HomeTeam, row.AwayTeam)
    fixtureMap.set(key, {
      source: SOURCE,
      source_fixture_id: key,
      league_id: leagueRow.id,
      home_team_id: home,
      away_team_id: away,
      kickoff,
      status: 'scheduled',
      updated_at: new Date().toISOString(),
    })
  }

  for (const row of resultRows) {
    if (!row.Date || !row.HomeTeam || !row.AwayTeam) continue
    const kickoff = ukDateTimeToIso(row.Date, row.Time || '12:00')
    const home = teamId.get(teamSourceKey(league, row.HomeTeam))
    const away = teamId.get(teamSourceKey(league, row.AwayTeam))
    const homeGoals = safeNumber(row.FTHG)
    const awayGoals = safeNumber(row.FTAG)
    if (!kickoff || !home || !away || homeGoals == null || awayGoals == null) continue
    const key = sourceFixtureId(league.div, row.Date, row.HomeTeam, row.AwayTeam)
    fixtureMap.set(key, {
      source: SOURCE,
      source_fixture_id: key,
      league_id: leagueRow.id,
      home_team_id: home,
      away_team_id: away,
      referee_id: row.Referee ? refereeId.get(refereeSourceKey(row.Referee)) ?? null : null,
      kickoff,
      status: 'finished',
      home_goals: homeGoals,
      away_goals: awayGoals,
      half_time_home_goals: safeNumber(row.HTHG),
      half_time_away_goals: safeNumber(row.HTAG),
      updated_at: new Date().toISOString(),
    })
  }

  const fixtures = [...fixtureMap.values()]
  if (!fixtures.length) return { fixtures: 0, stats: 0 }

  const { data: savedFixtures, error: fixturesError } = await supabase
    .from('fixtures')
    .upsert(fixtures, { onConflict: 'source,source_fixture_id' })
    .select('id,source_fixture_id,home_team_id,away_team_id')
  if (fixturesError) throw fixturesError

  const fixtureId = new Map((savedFixtures ?? []).map((fixture: any) => [fixture.source_fixture_id, fixture.id]))
  const stats: any[] = []

  for (const row of resultRows) {
    if (!row.Date || !row.HomeTeam || !row.AwayTeam || safeNumber(row.FTHG) == null || safeNumber(row.FTAG) == null) continue
    const key = sourceFixtureId(league.div, row.Date, row.HomeTeam, row.AwayTeam)
    const id = fixtureId.get(key)
    const home = teamId.get(teamSourceKey(league, row.HomeTeam))
    const away = teamId.get(teamSourceKey(league, row.AwayTeam))
    if (!id || !home || !away) continue

    stats.push({
      fixture_id: id, team_id: home, venue: 'home', goals: safeNumber(row.FTHG),
      yellow_cards: safeNumber(row.HY), red_cards: safeNumber(row.HR), corners: safeNumber(row.HC),
      fouls: safeNumber(row.HF), shots: safeNumber(row.HS), shots_on_target: safeNumber(row.HST), source: SOURCE,
    })
    stats.push({
      fixture_id: id, team_id: away, venue: 'away', goals: safeNumber(row.FTAG),
      yellow_cards: safeNumber(row.AY), red_cards: safeNumber(row.AR), corners: safeNumber(row.AC),
      fouls: safeNumber(row.AF), shots: safeNumber(row.AS), shots_on_target: safeNumber(row.AST), source: SOURCE,
    })
  }

  if (stats.length) {
    const { error } = await supabase.from('team_match_stats').upsert(stats, { onConflict: 'fixture_id,team_id' })
    if (error) throw error
  }

  return { fixtures: fixtures.length, stats: stats.length }
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as any },
  })

  const { data: syncRun } = await supabase
    .from('source_sync_runs')
    .insert({ source: SOURCE, job_name: 'daily-current-season-sync', status: 'running' })
    .select('id')
    .single()

  try {
    const season = currentSeasonCode()
    const fixtureRows = await getCsv(FIXTURES_CSV_URL)
    let total = 0
    const warnings: string[] = []

    for (const league of LEAGUES) {
      try {
        const resultRows = await getCsv(historicalCsvUrl(season, league.div))
        const result = await syncLeague(
          supabase,
          league,
          resultRows.filter((row) => (row.Div || league.div) === league.div),
          fixtureRows.filter((row) => row.Div === league.div),
        )
        total += result.fixtures + result.stats
      } catch (error) {
        warnings.push(`${league.slug}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    await supabase.rpc('refresh_referee_profiles')

    if (syncRun?.id) {
      await supabase.from('source_sync_runs').update({
        finished_at: new Date().toISOString(),
        status: warnings.length ? 'partial' : 'success',
        rows_upserted: total,
        error_message: warnings.length ? warnings.join(' | ').slice(0, 5000) : null,
      }).eq('id', syncRun.id)
    }

    return new Response(JSON.stringify({ ok: true, season, rows: total, warnings }), {
      headers: { 'content-type': 'application/json' },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (syncRun?.id) {
      await supabase.from('source_sync_runs').update({
        finished_at: new Date().toISOString(), status: 'failed', error_message: message.slice(0, 5000),
      }).eq('id', syncRun.id)
    }
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
