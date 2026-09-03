import { createClient } from '@supabase/supabase-js'

// Best Bets prices used to refresh once per day even though the public scanner
// rejects prices older than 2 hours. Run after the hourly scanner publication
// instead, with bounded fixture selection and a quota guard.
export const config = { schedule: '23 * * * *' }

type Market = 'cards' | 'corners' | 'goals'
type Prediction = {
  id: string
  market: Market
  selection: string
  confidence: number
  data_quality: number
  fixture_id: string
  feature_snapshot_id: string | null
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

type Quota = { remaining: string | null; used: string | null; last: string | null }

const SOURCE = 'the-odds-api'
const MODEL = 'v0-research'
const API = 'https://api.the-odds-api.com/v4'
const MAX_FIXTURES_PER_RUN = 4
const PRICE_HORIZON_HOURS = 48
const PUBLIC_PRICE_TTL_HOURS = 2
const MIN_QUOTA_REMAINING = 20

// Conservative probabilities are the 95% Wilson lower bounds from the
// 2025/26 walk-forward backtest at the live publication thresholds.
const FAIR_PROBABILITY: Record<Market, number> = {
  cards: 0.656,
  corners: 0.670,
  goals: 0.806,
}

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
  if (selectionKey === 'over_1_5') return ['alternate_totals']
  if (selectionKey === 'second_half_0_5') return ['alternate_totals_h2', 'totals_h2']
  if (selectionKey === 'home_corners_4_5' || selectionKey === 'away_corners_4_5') return ['alternate_team_totals_corners']
  return []
}

function outcomeMatches(selectionKey: string, outcome: { name: string; description?: string; point?: number }, home: string, away: string) {
  const point = Number(outcome.point)
  if (selectionKey === 'over_1_5') return outcome.name.toLowerCase() === 'over' && Math.abs(point - 1.5) < 0.01
  if (selectionKey === 'second_half_0_5') return outcome.name.toLowerCase() === 'over' && Math.abs(point - 0.5) < 0.01
  if (selectionKey === 'home_corners_4_5' || selectionKey === 'away_corners_4_5') {
    if (outcome.name.toLowerCase() !== 'over' || Math.abs(point - 4.5) >= 0.01) return false
    const team = selectionKey.startsWith('home_') ? home : away
    const descriptor = outcome.description || outcome.name
    return teamSimilarity(team, descriptor) >= 0.55 || normalize(descriptor).includes(normalize(team))
  }
  return false
}

function hoursUntil(kickoff: string, now: Date) {
  return Math.max(0, (Date.parse(kickoff) - now.getTime()) / 3600000)
}

function refreshIntervalHours(hoursToKickoff: number) {
  return hoursToKickoff <= 8 ? 1 : PUBLIC_PRICE_TTL_HOURS
}

function priority(prediction: Prediction, now: Date) {
  const hours = hoursUntil(prediction.fixtures.kickoff, now)
  const urgency = hours <= 3 ? 500 : hours <= 8 ? 360 : hours <= 24 ? 220 : 100
  return urgency + prediction.confidence - hours
}

function quotaIsLow(quota: Quota | null) {
  if (!quota?.remaining) return false
  const remaining = Number(quota.remaining)
  return Number.isFinite(remaining) && remaining <= MIN_QUOTA_REMAINING
}

async function apiJson<T>(url: string) {
  const response = await fetch(url, { headers: { 'user-agent': 'EVE-Football-Scanner/0.6 (fresh-price-value-engine)' } })
  const quota: Quota = {
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
    return new Response(JSON.stringify({
      ok: false,
      setupRequired: true,
      missing: 'ODDS_API_KEY',
      message: 'Value Engine is built. Add a free The Odds API key to Netlify as ODDS_API_KEY, then run again.',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: run } = await supabase.from('source_sync_runs').insert({
    source: SOURCE,
    job_name: 'value-engine',
    status: 'running',
  }).select('id').single()

  try {
    const now = new Date()
    const horizon = new Date(now.getTime() + PRICE_HORIZON_HOURS * 3600000)

    const { data, error } = await supabase
      .from('predictions')
      .select(`id,market,selection,confidence,data_quality,fixture_id,feature_snapshot_id,
        fixtures!inner(kickoff,status,leagues(slug,name),home:teams!fixtures_home_team_id_fkey(name),away:teams!fixtures_away_team_id_fkey(name)),
        feature_snapshots(selection_key)`)
      .eq('model_version', MODEL)
      .eq('publish_status', 'published')
      .in('fixtures.status', ['scheduled', 'live'])
      .gte('fixtures.kickoff', now.toISOString())
      .lt('fixtures.kickoff', horizon.toISOString())
      .order('confidence', { ascending: false })
      .limit(80)
    if (error) throw error

    const predictions = (data ?? []) as unknown as Prediction[]

    // Keep the conservative calibrated probability attached to each currently
    // published core signal. The publication gate still decides which rows exist.
    for (const market of ['cards', 'corners', 'goals'] as Market[]) {
      const ids = predictions.filter((p) => p.market === market).map((p) => p.id)
      if (ids.length) {
        const { error: probabilityError } = await supabase
          .from('predictions')
          .update({ fair_probability: FAIR_PROBABILITY[market] })
          .in('id', ids)
        if (probabilityError) throw probabilityError
      }
    }

    const supported = predictions.filter((p) => requiredMarket(p.feature_snapshots?.selection_key ?? '').length > 0)
    const unsupported = predictions.filter((p) => !requiredMarket(p.feature_snapshots?.selection_key ?? '').length)

    const latestPriceAt = new Map<string, number>()
    const supportedIds = supported.map((p) => p.id)
    if (supportedIds.length) {
      const oldestRelevant = new Date(now.getTime() - 48 * 3600000).toISOString()
      const { data: snapshots, error: snapshotError } = await supabase
        .from('odds_snapshots')
        .select('prediction_id,captured_at')
        .in('prediction_id', supportedIds)
        .gte('captured_at', oldestRelevant)
        .order('captured_at', { ascending: false })
      if (snapshotError) throw snapshotError
      for (const row of snapshots ?? []) {
        if (!latestPriceAt.has(row.prediction_id)) latestPriceAt.set(row.prediction_id, Date.parse(row.captured_at))
      }
    }

    const duePredictions = supported.filter((p) => {
      const interval = refreshIntervalHours(hoursUntil(p.fixtures.kickoff, now))
      const latest = latestPriceAt.get(p.id)
      return !latest || now.getTime() - latest >= interval * 3600000
    }).sort((a, b) => priority(b, now) - priority(a, now))

    const fixturePriority = new Map<string, number>()
    for (const p of duePredictions) {
      fixturePriority.set(p.fixture_id, Math.max(fixturePriority.get(p.fixture_id) ?? -Infinity, priority(p, now)))
    }
    const selectedFixtureIds = [...fixturePriority.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_FIXTURES_PER_RUN)
      .map(([fixtureId]) => fixtureId)
    const selected = duePredictions.filter((p) => selectedFixtureIds.includes(p.fixture_id))

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

    let matchedEvents = 0
    let pricedPredictions = 0
    let snapshotsInserted = 0
    let apiCalls = 0
    let lastQuota: Quota | null = null
    let quotaGuardTriggered = false

    outer: for (const [sportKey, sportPredictions] of bySport) {
      const eventsUrl = `${API}/sports/${sportKey}/events?apiKey=${encodeURIComponent(apiKey)}&dateFormat=iso`
      const eventsResult = await apiJson<OddsEvent[]>(eventsUrl)
      apiCalls += 1
      lastQuota = eventsResult.quota
      if (quotaIsLow(lastQuota)) {
        warnings.push(`Odds API quota guard activated at ${lastQuota?.remaining ?? '?'} remaining credits`)
        quotaGuardTriggered = true
        break
      }

      const fixtureGroups = new Map<string, { event: OddsEvent; predictions: Prediction[] }>()
      for (const prediction of sportPredictions) {
        const event = findEvent(prediction, eventsResult.data)
        if (!event) {
          warnings.push(`No odds event match: ${prediction.fixtures.home?.name} v ${prediction.fixtures.away?.name}`)
          continue
        }
        const group = fixtureGroups.get(event.id) ?? { event, predictions: [] }
        group.predictions.push(prediction)
        fixtureGroups.set(event.id, group)
      }

      for (const { event, predictions: eventPredictions } of fixtureGroups.values()) {
        matchedEvents += 1
        const markets = [...new Set(eventPredictions.flatMap((p) => requiredMarket(p.feature_snapshots?.selection_key ?? '')))]
        if (!markets.length) continue

        const oddsUrl = `${API}/sports/${sportKey}/events/${event.id}/odds?apiKey=${encodeURIComponent(apiKey)}&regions=uk&markets=${encodeURIComponent(markets.join(','))}&oddsFormat=decimal&dateFormat=iso`
        const oddsResult = await apiJson<OddsEvent>(oddsUrl)
        apiCalls += 1
        lastQuota = oddsResult.quota
        const oddsEvent = oddsResult.data

        for (const prediction of eventPredictions) {
          const selectionKey = prediction.feature_snapshots?.selection_key ?? ''
          const acceptedMarkets = new Set(requiredMarket(selectionKey))
          const hours = hoursUntil(prediction.fixtures.kickoff, now)
          const rows: Array<{ prediction_id: string; bookmaker: string; decimal_odds: number; is_closing: boolean }> = []

          for (const bookmaker of oddsEvent.bookmakers ?? []) {
            let bestForBookmaker = 0
            for (const market of bookmaker.markets ?? []) {
              if (!acceptedMarkets.has(market.key)) continue
              for (const outcome of market.outcomes ?? []) {
                if (!outcomeMatches(selectionKey, outcome, prediction.fixtures.home?.name ?? '', prediction.fixtures.away?.name ?? '')) continue
                const price = Number(outcome.price)
                if (Number.isFinite(price) && price > bestForBookmaker) bestForBookmaker = price
              }
            }
            if (bestForBookmaker > 1) {
              rows.push({ prediction_id: prediction.id, bookmaker: bookmaker.title, decimal_odds: bestForBookmaker, is_closing: hours <= 2 })
            }
          }

          if (rows.length) {
            const { error: oddsError } = await supabase.from('odds_snapshots').insert(rows)
            if (oddsError) throw oddsError
            pricedPredictions += 1
            snapshotsInserted += rows.length
          } else {
            warnings.push(`No matching price returned: ${prediction.selection} — ${prediction.fixtures.home?.name} v ${prediction.fixtures.away?.name}`)
          }
        }

        if (quotaIsLow(lastQuota)) {
          warnings.push(`Odds API quota guard activated at ${lastQuota?.remaining ?? '?'} remaining credits`)
          quotaGuardTriggered = true
          break outer
        }
      }
    }

    if (run?.id) {
      await supabase.from('source_sync_runs').update({
        finished_at: new Date().toISOString(),
        status: warnings.length ? 'partial' : 'success',
        rows_upserted: snapshotsInserted,
        error_message: warnings.length ? warnings.slice(0, 20).join(' | ') : null,
      }).eq('id', run.id)
    }

    return new Response(JSON.stringify({
      ok: true,
      provider: 'The Odds API',
      region: 'uk',
      fairProbability: FAIR_PROBABILITY,
      schedule: 'hourly after publication',
      horizonHours: PRICE_HORIZON_HOURS,
      publicPriceTtlHours: PUBLIC_PRICE_TTL_HOURS,
      maxFixturesPerRun: MAX_FIXTURES_PER_RUN,
      liveSignalsInHorizon: predictions.length,
      oddsSupportedSignals: supported.length,
      dueSignalsThisRun: duePredictions.length,
      selectedFixtures: selectedFixtureIds.length,
      matchedEvents,
      pricedPredictions,
      snapshotsInserted,
      apiCalls,
      quota: lastQuota,
      quotaGuardTriggered,
      refreshPolicy: {
        '0-8h': 'hourly',
        '8-48h': 'at least every 2 hours',
      },
      unsupportedSignals: unsupported.map((p) => ({
        market: p.market,
        selection: p.selection,
        reason: p.market === 'cards'
          ? 'Provider has match-card totals/handicaps but not the current EVE team 2+ card market.'
          : 'No exact market mapping.',
      })),
      warnings,
      valueRule: 'VALUE requires >=5 percentage-point conservative probability edge and >=5% expected value. STRONG requires >=7pp edge and >=10% EV.',
      note: 'Best Bets prices now refresh on the same hourly operating cycle as the scanner. No supported published price is intentionally left beyond the public 2-hour trust window, and quota use is bounded by the 48-hour horizon, fixture cap, due-price gating and quota guard.',
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
    return new Response(JSON.stringify({ ok: false, error: message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }
}
