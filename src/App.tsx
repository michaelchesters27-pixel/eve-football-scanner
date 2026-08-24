import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Activity,
  BarChart3,
  CircleDollarSign,
  CloudRain,
  Database,
  Flag,
  Goal,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserRoundCheck,
} from 'lucide-react'

type Market = 'cards' | 'corners' | 'goals'
type Grade = 'A+' | 'A' | 'B' | 'C'
type ValueStatus = 'strong' | 'value' | 'no_value' | 'waiting' | 'uncalibrated'

type Evidence = {
  key: string
  label: string
  display: string
  score: number
}

type RefereeInfo = {
  name: string
  cardsPerMatch: number
  foulsPerMatch?: number
}

type Pick = {
  id: string
  country: string
  league: string
  homeTeam: string
  awayTeam: string
  kickoff: string
  market: Market
  selection: string
  confidence: number
  grade: Grade
  dataQuality: number
  evidence: Evidence[]
  referee?: RefereeInfo
  researchNote?: string
  fairProbability?: number | null
  fairOdds?: number | null
  bestBookmaker?: string | null
  bestOdds?: number | null
  impliedProbability?: number | null
  edgePct?: number | null
  expectedValuePct?: number | null
  valueStatus?: ValueStatus | null
}

const weights: Record<Market, Record<string, number>> = {
  cards: { recent: 0.24, venue: 0.20, opponent: 0.17, referee: 0.18, season: 0.11, h2h: 0.10 },
  corners: { recent: 0.26, venue: 0.24, opponent: 0.20, season: 0.18, h2h: 0.12 },
  goals: { recent: 0.24, venue: 0.22, opponent: 0.20, season: 0.18, h2h: 0.10, context: 0.06 },
}

function gradeFor(score: number): Grade {
  if (score >= 84) return 'A+'
  if (score >= 78) return 'A'
  if (score >= 70) return 'B'
  return 'C'
}

function scoreEvidence(market: Market, evidence: Evidence[], dataQuality = 94) {
  const marketWeights = weights[market]
  let weighted = 0
  let weightUsed = 0
  for (const item of evidence) {
    const weight = marketWeights[item.key]
    if (!weight) continue
    weighted += item.score * weight
    weightUsed += weight
  }
  const raw = weightUsed ? weighted / weightUsed : 0
  const qualityAdjustment = 0.88 + (Math.min(100, dataQuality) / 100) * 0.12
  return Math.round(raw * qualityAdjustment)
}

function demoPick(input: Omit<Pick, 'confidence' | 'grade'>): Pick {
  const confidence = scoreEvidence(input.market, input.evidence, input.dataQuality)
  return { ...input, confidence, grade: gradeFor(confidence) }
}

const demoPicks: Pick[] = [
  demoPick({
    id: 'demo-1', country: 'England', league: 'Premier League', homeTeam: 'North London FC', awayTeam: 'West London FC', kickoff: '15:00',
    market: 'cards', selection: 'Home Team — 2+ Yellow Cards', dataQuality: 97,
    referee: { name: 'Demo Referee A', cardsPerMatch: 5.1, foulsPerMatch: 23.8 },
    evidence: [
      { key: 'recent', label: 'Recent 10', display: '8/10 cleared', score: 88 },
      { key: 'venue', label: 'Home split', display: '82% cleared', score: 86 },
      { key: 'opponent', label: 'Opponent draws cards', display: '2.3 per match', score: 84 },
      { key: 'referee', label: 'Referee', display: '5.1 yellows/match', score: 91 },
      { key: 'season', label: 'Season baseline', display: '2.18 cards/match', score: 80 },
      { key: 'h2h', label: 'Recent H2H', display: '4/5 cleared', score: 78 },
    ],
    researchNote: 'Strong agreement across venue, opponent and referee factors.',
  }),
  demoPick({
    id: 'demo-2', country: 'Italy', league: 'Serie A', homeTeam: 'Capital FC', awayTeam: 'Florence FC', kickoff: '17:30',
    market: 'cards', selection: 'Away Team — 2+ Yellow Cards', dataQuality: 95,
    referee: { name: 'Demo Referee B', cardsPerMatch: 5.4, foulsPerMatch: 25.1 },
    evidence: [
      { key: 'recent', label: 'Recent 10', display: '9/10 cleared', score: 92 },
      { key: 'venue', label: 'Away split', display: '84% cleared', score: 88 },
      { key: 'opponent', label: 'Opponent draws cards', display: '2.5 per match', score: 87 },
      { key: 'referee', label: 'Referee', display: '5.4 yellows/match', score: 94 },
      { key: 'season', label: 'Season baseline', display: '2.31 cards/match', score: 84 },
      { key: 'h2h', label: 'Recent H2H', display: '4/5 cleared', score: 80 },
    ],
  }),
  demoPick({
    id: 'demo-3', country: 'Germany', league: 'Bundesliga', homeTeam: 'Rhine FC', awayTeam: 'Bavaria FC', kickoff: '14:30',
    market: 'corners', selection: 'Away Team — 5+ Corners', dataQuality: 93,
    evidence: [
      { key: 'recent', label: 'Recent 10', display: '8/10 cleared', score: 86 },
      { key: 'venue', label: 'Away split', display: '6.4 avg corners', score: 88 },
      { key: 'opponent', label: 'Home team concedes', display: '5.8 avg corners', score: 84 },
      { key: 'season', label: 'Season baseline', display: '6.1 avg corners', score: 83 },
      { key: 'h2h', label: 'Recent H2H', display: '4/5 cleared', score: 76 },
    ],
  }),
  demoPick({
    id: 'demo-4', country: 'Netherlands', league: 'Eredivisie', homeTeam: 'Amsterdam FC', awayTeam: 'Rotterdam FC', kickoff: '19:00',
    market: 'goals', selection: 'Match — Over 1.5 Goals', dataQuality: 96,
    evidence: [
      { key: 'recent', label: 'Recent 10', display: '9/10 cleared', score: 92 },
      { key: 'venue', label: 'Home/away split', display: '3.1 combined avg', score: 90 },
      { key: 'opponent', label: 'Scoring/conceding mix', display: 'Both profiles positive', score: 87 },
      { key: 'season', label: 'Season baseline', display: '86% cleared', score: 88 },
      { key: 'h2h', label: 'Recent H2H', display: '5/5 cleared', score: 84 },
      { key: 'context', label: 'Match context', display: 'Normal league fixture', score: 75 },
    ],
  }),
  demoPick({
    id: 'demo-5', country: 'Spain', league: 'La Liga', homeTeam: 'Madrid FC', awayTeam: 'Seville FC', kickoff: '20:00',
    market: 'corners', selection: 'Home Team — 5+ Corners', dataQuality: 91,
    evidence: [
      { key: 'recent', label: 'Recent 10', display: '7/10 cleared', score: 78 },
      { key: 'venue', label: 'Home split', display: '6.3 avg corners', score: 86 },
      { key: 'opponent', label: 'Away team concedes', display: '5.6 avg corners', score: 82 },
      { key: 'season', label: 'Season baseline', display: '5.9 avg corners', score: 81 },
      { key: 'h2h', label: 'Recent H2H', display: '3/5 cleared', score: 65 },
    ],
  }),
  demoPick({
    id: 'demo-6', country: 'France', league: 'Ligue 1', homeTeam: 'Paris FC', awayTeam: 'Lyon FC', kickoff: '20:00',
    market: 'goals', selection: 'Second Half — Over 0.5 Goals', dataQuality: 92,
    evidence: [
      { key: 'recent', label: 'Recent 10', display: '8/10 cleared', score: 86 },
      { key: 'venue', label: 'Home/away split', display: '81% cleared', score: 84 },
      { key: 'opponent', label: 'Second-half profile', display: 'Strong', score: 82 },
      { key: 'season', label: 'Season baseline', display: '79% cleared', score: 81 },
      { key: 'h2h', label: 'Recent H2H', display: '4/5 cleared', score: 78 },
      { key: 'context', label: 'Match context', display: 'No adverse flag', score: 74 },
    ],
  }),
]

const marketMeta = {
  cards: { label: 'Yellow Cards', icon: ShieldCheck },
  corners: { label: 'Corners', icon: Flag },
  goals: { label: 'Goals', icon: Goal },
}

function App() {
  const [activeMarket, setActiveMarket] = useState<'all' | Market>('all')
  const [picks, setPicks] = useState<Pick[]>(demoPicks)
  const [dataMode, setDataMode] = useState<'demo' | 'live' | 'error'>('demo')
  const [dataMessage, setDataMessage] = useState('Waiting for the dedicated free Supabase project')

  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
    if (!url || !key) return

    const supabase = createClient(url, key)
    supabase
      .from('scanner_best_bets')
      .select('*')
      .order('confidence', { ascending: false })
      .limit(25)
      .then(({ data, error }) => {
        if (error) {
          setDataMode('error')
          setDataMessage(`Supabase connected, but scanner view is not ready: ${error.message}`)
          return
        }
        if (!data?.length) {
          setPicks([])
          setDataMode('error')
          setDataMessage('Supabase connected; no qualified scanner selections yet')
          return
        }
        setPicks(data as Pick[])
        setDataMode('live')
        setDataMessage('Live data from the dedicated EVE Football Supabase project')
      })
  }, [])

  const filtered = useMemo(
    () => picks.filter((pick) => activeMarket === 'all' || pick.market === activeMarket).sort((a, b) => b.confidence - a.confidence),
    [activeMarket, picks],
  )

  const topScore = picks.length ? Math.max(...picks.map((pick) => pick.confidence)) : 0
  const averageQuality = picks.length ? Math.round(picks.reduce((sum, pick) => sum + pick.dataQuality, 0) / picks.length) : 0
  const valueCount = picks.filter((pick) => pick.valueStatus === 'value' || pick.valueStatus === 'strong').length

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <div className="brand-mark"><Activity size={22} /></div>
          <div>
            <div className="eyebrow">EVE ANALYTICS</div>
            <h1>Football Scanner</h1>
          </div>
        </div>
        <div className={`mode-pill ${dataMode}`}>
          <span className="pulse-dot" />
          {dataMode === 'live' ? 'LIVE DATA' : dataMode === 'error' ? 'CONNECTION CHECK' : 'RESEARCH / DEMO'}
        </div>
      </header>

      <main>
        <section className="hero">
          <div>
            <div className="eyebrow">STATISTICAL MARKET INTELLIGENCE</div>
            <h2>Find the strongest evidence.<br /><span>Ignore the noise.</span></h2>
            <p>Cards, corners and goals ranked from home/away form, recent performance, opponent tendencies, H2H and referee data.</p>
          </div>
          <div className="hero-status">
            <Database size={19} />
            <div><strong>Data status</strong><span>{dataMessage}</span></div>
          </div>
        </section>

        <section className="kpis">
          <Kpi icon={Trophy} label="Qualified candidates" value={String(picks.length)} detail="Passed calibrated filters" />
          <Kpi icon={Sparkles} label="Top EVE score" value={`${topScore}%`} detail="Statistical score" />
          <Kpi icon={Database} label="Data quality" value={`${averageQuality}%`} detail="Coverage score" />
          <Kpi icon={CircleDollarSign} label="Value bets now" value={String(valueCount)} detail="VALUE / STRONG VALUE only" />
        </section>

        {dataMode === 'live' && (
          <section className="qualification-panel">
            <div className="qualification-count"><Trophy size={20} /><strong>{picks.length} QUALIFIED FROM THE FULL SCAN</strong></div>
            <p>
              EVE scans every supported upcoming fixture across Yellow Cards, Corners and Goals. Only selections that pass the market-specific calibrated statistical filters appear below. These are the strongest current candidates — <strong>not automatically {picks.length} bets.</strong>
            </p>
            <div className="qualification-rule"><CircleDollarSign size={17} /><span><strong>Final betting rule:</strong> only VALUE or STRONG VALUE should be considered. NO VALUE = skip. WAITING PRICE = no decision yet.</span></div>
          </section>
        )}

        <section className="scanner-section">
          <div className="section-head">
            <div>
              <div className="eyebrow">CURRENT QUALIFIERS</div>
              <h3>Strongest candidates from the full scan</h3>
            </div>
            <div className="tabs">
              <button className={activeMarket === 'all' ? 'active' : ''} onClick={() => setActiveMarket('all')}>All</button>
              {(Object.keys(marketMeta) as Market[]).map((market) => {
                const Icon = marketMeta[market].icon
                return <button key={market} className={activeMarket === market ? 'active' : ''} onClick={() => setActiveMarket(market)}><Icon size={15} />{marketMeta[market].label}</button>
              })}
            </div>
          </div>

          <div className="pick-grid">
            {filtered.map((pick, index) => <PickCard key={pick.id} pick={pick} rank={index + 1} />)}
          </div>
        </section>

        <section className="engine-grid">
          <Engine icon={ShieldCheck} title="Card Engine" text="Venue card rate + opponent cards drawn + recent form + H2H + referee strictness." />
          <Engine icon={Flag} title="Corner Engine" text="Corners won/conceded + venue splits + recent frequency + opponent profile + H2H." />
          <Engine icon={Goal} title="Goal Engine" text="Scoring/conceding rates + half splits + home/away + recent form + H2H + context." />
          <Engine icon={UserRoundCheck} title="Referee Engine" text="Yellow-card rate, fouls, home/away distribution, recent appointments and league baseline." />
          <Engine icon={CloudRain} title="Context Engine" text="Weather and match context remain research factors only where data supports them." />
          <Engine icon={CircleDollarSign} title="Value Engine" text="Compares EVE's conservative fair probability with current bookmaker price. NO VALUE means skip the bet." />
        </section>
      </main>

      <footer>EVE Football Scanner · Live statistical shortlist · Value filtered</footer>
    </div>
  )
}

function Kpi({ icon: Icon, label, value, detail }: { icon: typeof Activity; label: string; value: string; detail: string }) {
  return <div className="kpi-card"><div className="kpi-icon"><Icon size={18} /></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>
}

function Engine({ icon: Icon, title, text }: { icon: typeof Activity; title: string; text: string }) {
  return <article className="engine-card"><Icon size={20} /><div><h4>{title}</h4><p>{text}</p></div></article>
}

function valueLabel(status?: ValueStatus | null) {
  if (status === 'strong') return 'STRONG VALUE'
  if (status === 'value') return 'VALUE'
  if (status === 'no_value') return 'NO VALUE — SKIP'
  if (status === 'waiting') return 'WAITING PRICE'
  return 'WAITING CALIBRATION'
}

function PickCard({ pick, rank }: { pick: Pick; rank: number }) {
  const Icon = marketMeta[pick.market].icon
  return (
    <article className="pick-card">
      <div className="pick-top">
        <div className="rank">#{rank}</div>
        <div className={`grade grade-${pick.grade.replace('+', 'plus').toLowerCase()}`}>{pick.grade}</div>
      </div>
      <div className="league-line">{pick.country} · {pick.league} · {pick.kickoff}</div>
      <h4>{pick.homeTeam} <span>vs</span> {pick.awayTeam}</h4>
      <div className="selection"><Icon size={17} /><span>{pick.selection}</span></div>

      {pick.valueStatus && (
        <div className={`value-strip value-${pick.valueStatus}`}>
          <div><CircleDollarSign size={16} /><strong>{valueLabel(pick.valueStatus)}</strong></div>
          <span>{pick.bestOdds ? `${pick.bestBookmaker ?? 'Best price'} ${Number(pick.bestOdds).toFixed(2)}` : 'No compatible price available yet'}</span>
        </div>
      )}

      <div className="confidence-row"><span>EVE statistical score</span><strong>{pick.confidence}%</strong></div>
      <div className="meter"><i style={{ width: `${pick.confidence}%` }} /></div>

      {(pick.fairOdds != null || pick.bestOdds != null) && (
        <div className="value-metrics">
          <div><span>Fair odds</span><strong>{pick.fairOdds != null ? Number(pick.fairOdds).toFixed(2) : '—'}</strong></div>
          <div><span>Best odds</span><strong>{pick.bestOdds != null ? Number(pick.bestOdds).toFixed(2) : '—'}</strong></div>
          <div><span>Edge</span><strong>{pick.edgePct != null ? `${Number(pick.edgePct).toFixed(1)}%` : '—'}</strong></div>
          <div><span>EV</span><strong>{pick.expectedValuePct != null ? `${Number(pick.expectedValuePct).toFixed(1)}%` : '—'}</strong></div>
        </div>
      )}

      <div className="evidence-grid">
        {pick.evidence.map((item) => <div className="evidence" key={`${pick.id}-${item.key}`}><span>{item.label}</span><strong>{item.display}</strong><small>{item.score}/100 factor</small></div>)}
      </div>
      {pick.referee && <div className="referee-line"><UserRoundCheck size={16} /><div><span>{pick.referee.name}</span><strong>{pick.referee.cardsPerMatch.toFixed(1)} cards/match{pick.referee.foulsPerMatch ? ` · ${pick.referee.foulsPerMatch.toFixed(1)} fouls` : ''}</strong></div></div>}
      <div className="quality-line"><span>Data quality</span><strong>{pick.dataQuality}%</strong></div>
      {pick.researchNote && <p className="research-note">{pick.researchNote}</p>}
    </article>
  )
}

export default App
