import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '5 6 * * *' }

type Prediction = {
  id: string
  market: string
  selection: string
  confidence: number
  data_quality: number
  fair_probability: number | null
  fixture_id: string
  fixtures: {
    kickoff: string
    status: string
    leagues: { slug: string; name: string } | null
    home: { name: string } | null
    away: { name: string } | null
  }
  feature_snapshots: { selection_key: string } | null
}

type OddsEvent = {
  id: string
  commence_time: string
  home_team: string
  away_team: string
  bookmakers?: Array<{
    key: string
    title: string
    markets?: Array<{
      key: string
      outcomes?: Array<{ name: string; description?: string; price: number; point?: number }>
    }>
  }>
}

const SOURCE = 'the-odds-api-expanded'
const MODEL = 'v1-expanded-research'
const API = 'https://api.the-odds-api.com/v4'
const MAX_FIXTURES_PER_RUN = 8
const PRICE_HORIZON_HOURS = 72
const FRESH_PRICE_HOURS = 2

const SPORT_KEY_BY_LEAGUE: Record<string, string> = {
  'premier-league': 'soccer_epl',
  'championship': 'soccer_efl_champ',
  'scottish-premiership': 'soccer_spl',
  'bundesliga': 'soccer_germany_bundesliga',
  'serie-a': 'soccer_italy_serie_a',
  'la-liga': 'soccer_spain_la_liga',
  'ligue-1': 'soccer_france_ligue_one',
  'eredivisie': 'soccer_netherlands_eredivisie',
  'belgian-pro-league': 'soccer_belgium_first_div',
  'primeira-liga': 'soccer_portugal_primeira_liga',
  'super-lig': 'soccer_turkey_super_league',
}

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function normalize(value: string) {
  const expanded = value
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\bman utd\b/g, 'manchester united')
    .replace(/\bman city\b/g, 'manchester city')
    .replace(/\bspurs\b/g, 'tottenham hotspur')
    .replace(/\bwolves\b/g, 'wolverhampton wanderers')
    .replace(/\binter milan\b/g, 'internazionale')
    .replace(/\binter\b/g, 'internazionale')
    .replace(/\bparis saint germain\b/g, 'psg')
    .replace(/\bparis sg\b/g, 'psg')
    .replace(/\bbayern munich\b/g, 'bayern munchen')
    .replace(/\bborussia monchengladbach\b/g, 'monchengladbach')
    .replace(/\breal sociedad san sebastian\b/g, 'real sociedad')
    .replace(/\bathletic club bilbao\b/g, 'athletic bilbao')
    .replace(/\bdeportivo alaves\b/g, 'alaves')
    .replace(/\bbrighton and hove albion\b/g, 'brighton')
    .replace(/\bwest ham united\b/g, 'west ham')
    .replace(/\bnewcastle united\b/g, 'newcastle')
    .replace(/\bleeds united\b/g, 'leeds')
    .replace(/\bnottingham forest\b/g, 'nottm forest')
    .replace(/\bnottingham\b/g, 'nottm')
    .replace(/\bfc\b|\bafc\b|\bcf\b|\bsc\b|\bac\b|\bsv\b|\bcalcio\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return expanded.replace(/\s+/g, ' ')
}

function teamSimilarity(a: string, b: string) {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.includes(y) || y.includes(x)) return 0.9
  const xs = new Set(x.split(' ').filter((t) => t.length > 1))
  const ys = new Set(y.split(' ').filter((t) => t.length > 1))
  const intersection = [...xs].filter((t) => ys.has(t)).length
  const union = new Set([...xs, ...ys]).size
  return union ? intersection / union : 0
}

function findEvent(prediction: Prediction, events: OddsEvent[]) {
  const kickoff = Date.parse(prediction.fixtures.kickoff)
  let best: { event: OddsEvent; score: number } | null = null
  for (const event of events) {
    const eventTime = Date.parse(event.commence_time)
    const hours = Math.abs(eventTime - kickoff) / 3600000
    if (hours > 12) continue
    const hs = teamSimilarity(prediction.fixtures.home?.name ?? '', event.home_team)
    const as = teamSimilarity(prediction.fixtures.away?.name ?? '', event.away_team)
    if (hs < 0.42 || as < 0.42) continue
    const timeScore = Math.max(0, 1 - hours / 12)
    const score = hs * 0.45 + as * 0.45 + timeScore * 0.10
    if (!best || score > best.score) best = { event, score }
  }
  return best && best.score >= 0.62 ? best.event : null
}

function requiredMarket(selectionKey: string) {
  if (selectionKey === 'btts_yes') return 'btts'
  if (/^(home|away)_goals_(0_5|1_5)$/.test(selectionKey)) return 'alternate_team_totals'
  if (selectionKey === 'first_half_0_5') return 'alternate_totals_h1'
  if (selectionKey === 'match_cards_3_5') return 'alternate_totals_cards'
  if (selectionKey === 'match_corners_8_5') return 'alternate_totals_corners'
  return null
}

function outcomeMatches(selectionKey: string, outcome: { name: string; description?: string; point?: number }, home: string, away: string) {
  const name = outcome.name.toLowerCase()
  const point = Number(outcome.point)
  if (selectionKey === 'btts_yes') return name === 'yes'
  if (selectionKey === 'first_half_0_5') return name === 'over' && Math.abs(point - 0.5) < 0.01
  if (selectionKey === 'match_cards_3_5') return name === 'over' && Math.abs(point - 3.5) < 0.01
  if (selectionKey === 'match_corners_8_5') return name === 'over' && Math.abs(point - 8.5) < 0.01

  const teamGoal = selectionKey.match(/^(home|away)_goals_(0_5|1_5)$/)
  if (teamGoal) {
    const wantedPoint = teamGoal[2] === '0_5' ? 0.5 : 1.5
    if (name !== 'over' || Math.abs(point - wantedPoint) >= 0.01) return false
    const team = teamGoal[1] === 'home' ? home : away
    const descriptor = outcome.description || outcome.name
    return teamSimilarity(team, descriptor) >= 0.55 || normalize(descriptor).includes(normalize(team))
  }
  return false
}

async function apiJson<T>(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'EVE-Football-Scanner/0.4 (expanded-value-engine)' } })
  const quota = {
    remaining: response.headers.get('x-requests-remaining'),
    used: response.headers.get('x-requests-used'),
    last: response.headers.get('x-requests-last'),
  }
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 500)}`)
  }
  return { data: await response.json() as T, quota }
}

export default async () => {
  const apiKey = process.env.ODDS_API_KEY
  if (!apiKey) {
    return new Response(JSON.stringify({ ok: false, setupRequired: true, missing: 'ODDS_API_KEY' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: run } = await supabase.from('source_sync_runs').insert({
    source: SOURCE,
    job_name: 'expanded-value-engine',
    status: 'running',
  }).select('id').single()

  try {
    const now = new Date()
    const horizon = new Date(now.getTime() + PRICE_HORIZON_HOURS * 3600000)
    const freshCutoff = new Date(now.getTime() - FRESH_PRICE_HOURS * 3600000).toISOString()

    const { data, error } = await supabase
      .from('predictions')
      .select(`id,market,selection,confidence,data_quality,fair_probability,fixture_id,
        fixtures!inner(kickoff,status,leagues(slug,name),home:teams!fixtures_home_team_id_fkey(name),away:teams!fixtures_away_team_id_fkey(name)),
        feature_snapshots(selection_key)`)
      .eq('model_version', MODEL)
      .eq('publish_status', 'published')
      .not('fair_probability', 'is', null)
      .in('fixtures.status', ['scheduled', 'live'])
      .gte('fixtures.kickoff', now.toISOString())
      .lt('fixtures.kickoff', horizon.toISOString())
      .limit(100)
    if (error) throw error

    let predictions = (data ?? []) as unknown as Prediction[]
    predictions = predictions
      .filter((p) => requiredMarket(p.feature_snapshots?.selection_key ?? ''))
      .sort((a, b) => Date.parse(a.fixtures.kickoff) - Date.parse(b.fixtures.kickoff) || b.confidence - a.confidence)

    const predictionIds = predictions.map((p) => p.id)
    const freshIds = new Set<string>()
    if (predictionIds.length) {
      const { data: fresh, error: freshError } = await supabase
        .from('odds_snapshots')
        .select('prediction_id')
        .in('prediction_id', predictionIds)
        .gte('captured_at', freshCutoff)
      if (freshError) throw freshError
      for (const row of fresh ?? []) freshIds.add(row.prediction_id)
    }
    predictions = predictions.filter((p) => !freshIds.has(p.id))

    const selectedFixtureIds: string[] = []
    for (const p of predictions) {
      if (!selectedFixtureIds.includes(p.fixture_id)) selectedFixtureIds.push(p.fixture_id)
      if (selectedFixtureIds.length >= MAX_FIXTURES_PER_RUN) break
    }
    const selected = predictions.filter((p) => selectedFixtureIds.includes(p.fixture_id))

    const bySport = new Map<string, Prediction[]>()
    const warnings: string[] = []
    for (const prediction of selected) {
      const slug = prediction.fixtures.leagues?.slug ?? ''
      const sportKey = SPORT_KEY_BY_LEAGUE[slug]
      if (!sportKey) {
        warnings.push(`No odds sport mapping for ${slug}`)
        continue
      }
      const list = bySport.get(sportKey) ?? []
      list.push(prediction)
      bySport.set(sportKey, list)
    }

    let matchedFixtures = 0
    let pricedPredictions = 0
    let snapshotsInserted = 0
    let apiCalls = 0
    let lastQuota: { remaining: string | null; used: string | null; last: string | null } | null = null

    for (const [sportKey, sportPredictions] of bySport) {
      const eventsResult = await apiJson<OddsEvent[]>(`${API}/sports/${sportKey}/events?apiKey=${encodeURIComponent(apiKey)}&dateFormat=iso`)
      apiCalls += 1
      lastQuota = eventsResult.quota

      const groups = new Map<string, { event: OddsEvent; predictions: Prediction[] }>()
      for (const prediction of sportPredictions) {
        const event = findEvent(prediction, eventsResult.data)
        if (!event) {
          warnings.push(`No event match: ${prediction.fixtures.home?.name} v ${prediction.fixtures.away?.name}`)
          continue
        }
        const group = groups.get(event.id) ?? { event, predictions: [] }
        group.predictions.push(prediction)
        groups.set(event.id, group)
      }

      for (const { event, predictions: eventPredictions } of groups.values()) {
        const markets = [...new Set(eventPredictions.map((p) => requiredMarket(p.feature_snapshots?.selection_key ?? '')).filter(Boolean))] as string[]
        if (!markets.length) continue
        const oddsResult = await apiJson<OddsEvent>(`${API}/sports/${sportKey}/events/${event.id}/odds?apiKey=${encodeURIComponent(apiKey)}&regions=uk&markets=${encodeURIComponent(markets.join(','))}&oddsFormat=decimal&dateFormat=iso`)
        apiCalls += 1
        lastQuota = oddsResult.quota
        matchedFixtures += 1

        for (const prediction of eventPredictions) {
          const selectionKey = prediction.feature_snapshots?.selection_key ?? ''
          const marketKey = requiredMarket(selectionKey)
          if (!marketKey) continue
          const rows: Array<{ prediction_id: string; bookmaker: string; decimal_odds: number; is_closing: boolean }> = []

          for (const bookmaker of oddsResult.data.bookmakers ?? []) {
            let bestForBookmaker = 0
            for (const market of bookmaker.markets ?? []) {
              if (market.key !== marketKey) continue
              for (const outcome of market.outcomes ?? []) {
                if (!outcomeMatches(selectionKey, outcome, prediction.fixtures.home?.name ?? '', prediction.fixtures.away?.name ?? '')) continue
                const price = Number(outcome.price)
                if (Number.isFinite(price) && price > bestForBookmaker) bestForBookmaker = price
              }
            }
            if (bestForBookmaker > 1) rows.push({ prediction_id: prediction.id, bookmaker: bookmaker.title, decimal_odds: bestForBookmaker, is_closing: false })
          }

          if (rows.length) {
            const { error: insertError } = await supabase.from('odds_snapshots').insert(rows)
            if (insertError) throw insertError
            pricedPredictions += 1
            snapshotsInserted += rows.length
          } else {
            warnings.push(`No compatible ${marketKey} price: ${prediction.selection} — ${prediction.fixtures.home?.name} v ${prediction.fixtures.away?.name}`)
          }
        }
      }
    }

    if (run?.id) {
      await supabase.from('source_sync_runs').update({
        finished_at: new Date().toISOString(),
        status: warnings.length ? 'partial' : 'success',
        rows_upserted: snapshotsInserted,
        error_message: warnings.length ? warnings.slice(0, 30).join(' | ') : null,
      }).eq('id', run.id)
    }

    return new Response(JSON.stringify({
      ok: true,
      model: MODEL,
      provider: 'The Odds API',
      region: 'uk',
      horizonHours: PRICE_HORIZON_HOURS,
      maxFixturesPerRun: MAX_FIXTURES_PER_RUN,
      calibratedSignalsInHorizon: (data ?? []).length,
      skippedFreshPrices: freshIds.size,
      selectedFixtures: selectedFixtureIds.length,
      matchedFixtures,
      pricedPredictions,
      snapshotsInserted,
      apiCalls,
      quota: lastQuota,
      warnings,
      valueRule: 'STRONG VALUE requires >=7 percentage-point probability edge and >=10% EV. VALUE requires >=5pp edge and >=5% EV. Otherwise NO VALUE.',
      note: 'The engine uses the fair_probability already assigned by the 2025/26 walk-forward calibration. It never substitutes the raw EVE score as probability.',
    }), { headers: { 'content-type': 'application/json' } })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (run?.id) {
      await supabase.from('source_sync_runs').update({
        finished_at: new Date().toISOString(),
        status: 'failed',
        error_message: message.slice(0, 5000),
      }).eq('id', run.id)
    }
    return new Response(JSON.stringify({ ok: false, error: message }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
