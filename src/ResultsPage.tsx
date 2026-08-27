import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Activity, BarChart3, CheckCircle2, Clock3, Database, Trophy, XCircle } from 'lucide-react'

type ResultOutcome = 'win' | 'loss' | 'void' | 'push' | 'pending' | 'awaiting_data'
type ResultRow = {
  id: number
  predictionId: string
  fixtureId: string
  sourcePage: 'best_bets' | 'market_lab'
  modelVersion: string
  country: string
  league: string
  homeTeam: string
  awayTeam: string
  kickoffUtc: string
  market: string
  selection: string
  confidence: number
  grade: string
  dataQuality: number
  fairProbability?: number | null
  firstPublishedAt: string
  fixtureStatus: string
  homeGoals?: number | null
  awayGoals?: number | null
  outcome: ResultOutcome
  settledAt?: string | null
}

type Filter = 'all' | 'win' | 'loss' | 'pending' | 'best_bets' | 'market_lab'

const LONDON = 'Europe/London'

function dateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('en-GB', {
    timeZone: LONDON,
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function statusLabel(outcome: ResultOutcome) {
  if (outcome === 'win') return 'WIN'
  if (outcome === 'loss') return 'LOSS'
  if (outcome === 'void' || outcome === 'push') return 'VOID'
  if (outcome === 'awaiting_data') return 'AWAITING MATCH DATA'
  return 'PENDING'
}

function isPending(outcome: ResultOutcome) {
  return outcome === 'pending' || outcome === 'awaiting_data'
}

export default function ResultsPage() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
  const supabase = useMemo(() => url && key ? createClient(url, key) : null, [url, key])
  const [rows, setRows] = useState<ResultRow[]>([])
  const [message, setMessage] = useState('Loading EVE results…')
  const [filter, setFilter] = useState<Filter>('all')

  const load = async () => {
    if (!supabase) { setMessage('Supabase is not connected'); return }
    const { data, error } = await supabase.from('scanner_result_log').select('*').order('kickoffUtc', { ascending: false }).limit(500)
    if (error) {
      setMessage(`Results view not ready: ${error.message}`)
      setRows([])
      return
    }
    const resultRows = (data ?? []) as ResultRow[]
    setRows(resultRows)
    setMessage(resultRows.length ? `${resultRows.length} published EVE picks are permanently logged` : 'No published picks have been logged yet')
  }

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try { await fetch('/.netlify/functions/settle-results-now', { cache: 'no-store' }) } catch { /* scheduled settlement is the fallback */ }
      if (!cancelled) await load()
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5 * 60000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [supabase])

  const settled = rows.filter((r) => r.outcome === 'win' || r.outcome === 'loss')
  const wins = settled.filter((r) => r.outcome === 'win').length
  const losses = settled.filter((r) => r.outcome === 'loss').length
  const pending = rows.filter((r) => isPending(r.outcome)).length
  const winRate = settled.length ? Math.round((wins / settled.length) * 1000) / 10 : null

  const filtered = rows.filter((r) => {
    if (filter === 'all') return true
    if (filter === 'pending') return isPending(r.outcome)
    if (filter === 'best_bets' || filter === 'market_lab') return r.sourcePage === filter
    return r.outcome === filter
  })

  return <div className="app-shell results-shell">
    <header className="topbar results-topbar">
      <div className="brand-row">
        <div className="brand-mark"><Activity size={22}/></div>
        <div><div className="eyebrow">EVE ANALYTICS</div><h1>Football Scanner</h1></div>
      </div>
      <div className="header-right">
        <nav className="page-nav results-nav">
          <a href="#/best"><Trophy size={15}/>Best Bets</a>
          <a href="#/markets"><BarChart3 size={15}/>Market Lab</a>
          <a className="active" href="#/results"><CheckCircle2 size={15}/>Results</a>
        </nav>
        <div className={`mode-pill ${supabase ? 'live' : 'error'}`}><span className="pulse-dot"/>{supabase ? 'LIVE DATA' : 'NOT CONNECTED'}</div>
      </div>
    </header>

    <main className="results-main">
      <section className="hero compact-hero">
        <div>
          <div className="eyebrow">LIVE TRACK RECORD</div>
          <h2>Every EVE pick.<br/><span>Win or lose.</span></h2>
          <p>This is not the backtest. It is the permanent record of selections that the live scanner actually published. Once a pick appears, EVE keeps it in the history and settles it from the completed match.</p>
        </div>
        <div className="hero-status"><Database size={19}/><div><strong>Results status</strong><span>{message}</span></div></div>
      </section>

      <section className="kpis results-kpis">
        <div className="kpi-card"><div className="kpi-icon"><CheckCircle2 size={18}/></div><div><span>Wins</span><strong>{wins}</strong><small>Settled wins</small></div></div>
        <div className="kpi-card"><div className="kpi-icon result-loss-icon"><XCircle size={18}/></div><div><span>Losses</span><strong>{losses}</strong><small>Settled losses</small></div></div>
        <div className="kpi-card"><div className="kpi-icon"><Trophy size={18}/></div><div><span>Win percentage</span><strong>{winRate == null ? '—' : `${winRate}%`}</strong><small>Wins ÷ wins + losses</small></div></div>
        <div className="kpi-card"><div className="kpi-icon result-pending-icon"><Clock3 size={18}/></div><div><span>Pending</span><strong>{pending}</strong><small>Not included in win %</small></div></div>
      </section>

      <section className="qualification-panel results-explainer">
        <div className="qualification-count"><CheckCircle2 size={20}/><strong>{settled.length} SETTLED PICKS · {rows.length} TOTAL LOGGED</strong></div>
        <p>The percentage only uses genuine <strong>wins and losses</strong>. Upcoming games and matches waiting for card/corner data are not counted. This prevents missing data from being recorded as a fake loss.</p>
        <div className="qualification-rule"><Database size={17}/><span><strong>Important:</strong> Results are for live scanner picks, not historical backtest selections. Best Bets and Market Lab are labelled separately.</span></div>
      </section>

      <section className="scanner-section">
        <div className="section-head">
          <div><div className="eyebrow">PICK-BY-PICK LOG</div><h3>Date · Event · Bet · Result</h3></div>
          <div className="tabs results-tabs">
            <button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>All</button>
            <button className={filter==='win'?'active':''} onClick={()=>setFilter('win')}>Wins</button>
            <button className={filter==='loss'?'active':''} onClick={()=>setFilter('loss')}>Losses</button>
            <button className={filter==='pending'?'active':''} onClick={()=>setFilter('pending')}>Pending</button>
            <button className={filter==='best_bets'?'active':''} onClick={()=>setFilter('best_bets')}>Best Bets</button>
            <button className={filter==='market_lab'?'active':''} onClick={()=>setFilter('market_lab')}>Market Lab</button>
          </div>
        </div>

        {filtered.length ? <div className="result-list">{filtered.map((row)=><article className="result-row-card" key={row.id}>
          <div className="result-date"><span>{dateLabel(row.kickoffUtc)}</span><small>{row.country} · {row.league}</small></div>
          <div className="result-event"><strong>{row.homeTeam} <i>vs</i> {row.awayTeam}</strong><small>{row.homeGoals != null && row.awayGoals != null ? `Final score ${row.homeGoals}-${row.awayGoals}` : row.fixtureStatus.toUpperCase()}</small></div>
          <div className="result-bet"><span>{row.sourcePage === 'best_bets' ? 'BEST BETS' : 'MARKET LAB'}</span><strong>{row.selection}</strong><small>EVE {row.confidence}% · Grade {row.grade} · Data {row.dataQuality}%</small></div>
          <div className={`result-outcome outcome-${row.outcome}`}><strong>{statusLabel(row.outcome)}</strong></div>
        </article>)}</div> : <div className="empty-state"><Database size={21}/><span>No results match this filter yet.</span></div>}
      </section>
    </main>

    <footer>EVE Football Scanner · Permanent live pick log · Pending results excluded from win percentage</footer>
  </div>
}
