import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Activity, BarChart3, CheckCircle2, Clock3, Database, Layers3, Trophy, XCircle } from 'lucide-react'

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

type ComboResultRow = {
  id: string
  comboLogId: number
  fixtureId: string
  comboType: 'single' | 'double' | 'treble'
  position: number
  legKeys: string[]
  legLabels: string[]
  historicalProbability?: number | null
  sampleSize: number
  dataQuality: number
  capturedAt: string
  country: string
  league: string
  homeTeam: string
  awayTeam: string
  kickoffUtc: string
  fixtureStatus: string
  homeGoals?: number | null
  awayGoals?: number | null
  outcome: ResultOutcome
}

type Filter = 'all' | 'win' | 'loss' | 'pending' | 'best_bets' | 'market_lab'
type ComboFilter = 'all' | 'single' | 'double' | 'treble' | 'win' | 'loss' | 'pending'
type Mode = 'scanner' | 'combo'

const LONDON = 'Europe/London'

function dateLabel(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('en-GB', {
    timeZone: LONDON, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function statusLabel(outcome: ResultOutcome) {
  if (outcome === 'win') return 'WIN'
  if (outcome === 'loss') return 'LOSS'
  if (outcome === 'void' || outcome === 'push') return 'VOID'
  if (outcome === 'awaiting_data') return 'AWAITING MATCH DATA'
  return 'PENDING'
}
function isPending(outcome: ResultOutcome) { return outcome === 'pending' || outcome === 'awaiting_data' }
function pct(wins:number, settled:number){ return settled ? Math.round(wins / settled * 1000) / 10 : null }

export default function ResultsPage() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
  const supabase = useMemo(() => url && key ? createClient(url, key) : null, [url, key])
  const [rows, setRows] = useState<ResultRow[]>([])
  const [comboRows, setComboRows] = useState<ComboResultRow[]>([])
  const [message, setMessage] = useState('Loading EVE results…')
  const [comboMessage, setComboMessage] = useState('Loading Combo Lab results…')
  const [filter, setFilter] = useState<Filter>('all')
  const [comboFilter, setComboFilter] = useState<ComboFilter>('all')
  const [mode, setMode] = useState<Mode>('scanner')

  const load = async () => {
    if (!supabase) { setMessage('Supabase is not connected'); setComboMessage('Supabase is not connected'); return }
    const [scanner, combos] = await Promise.all([
      supabase.from('scanner_result_log').select('*').order('kickoffUtc', { ascending: false }).limit(500),
      supabase.from('combo_result_log').select('*').order('kickoffUtc', { ascending: false }).limit(1000),
    ])
    if (scanner.error) { setMessage(`Results view not ready: ${scanner.error.message}`); setRows([]) }
    else {
      const resultRows=(scanner.data??[]) as ResultRow[]
      setRows(resultRows)
      setMessage(resultRows.length ? `${resultRows.length} final EVE picks permanently logged` : 'No final scanner picks logged yet')
    }
    if (combos.error) { setComboMessage('Combo results patch not installed yet'); setComboRows([]) }
    else {
      const resultRows=(combos.data??[]) as ComboResultRow[]
      setComboRows(resultRows)
      setComboMessage(resultRows.length ? `${resultRows.length} Combo Lab singles/doubles/trebles permanently tracked` : 'No Combo Lab recommendations logged yet')
    }
  }

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      try { await fetch('/.netlify/functions/settle-results-now', { cache: 'no-store' }) } catch { /* scheduled fallback */ }
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
  const winRate = pct(wins,settled.length)

  const filtered = rows.filter((r) => {
    if (filter === 'all') return true
    if (filter === 'pending') return isPending(r.outcome)
    if (filter === 'best_bets' || filter === 'market_lab') return r.sourcePage === filter
    return r.outcome === filter
  })

  const comboSettled=comboRows.filter((r)=>r.outcome==='win'||r.outcome==='loss')
  const comboWins=comboSettled.filter((r)=>r.outcome==='win').length
  const comboPending=comboRows.filter((r)=>isPending(r.outcome)).length
  const comboStats=(type:ComboResultRow['comboType'])=>{
    const all=comboRows.filter((r)=>r.comboType===type)
    const s=all.filter((r)=>r.outcome==='win'||r.outcome==='loss')
    const w=s.filter((r)=>r.outcome==='win').length
    return { all:all.length, settled:s.length, wins:w, rate:pct(w,s.length) }
  }
  const singles=comboStats('single'), doubles=comboStats('double'), trebles=comboStats('treble')
  const filteredCombos=comboRows.filter((r)=>{
    if(comboFilter==='all')return true
    if(comboFilter==='pending')return isPending(r.outcome)
    if(comboFilter==='single'||comboFilter==='double'||comboFilter==='treble')return r.comboType===comboFilter
    return r.outcome===comboFilter
  })

  const activeMessage=mode==='scanner'?message:comboMessage

  return <div className="app-shell results-shell">
    <header className="topbar results-topbar">
      <div className="brand-row"><div className="brand-mark"><Activity size={22}/></div><div><div className="eyebrow">EVE ANALYTICS</div><h1>Football Scanner</h1></div></div>
      <div className="header-right">
        <nav className="page-nav results-nav"><a href="#/best"><Trophy size={15}/>Best Bets</a><a href="#/markets"><BarChart3 size={15}/>Market Lab</a><a href="#/combos"><Layers3 size={15}/>Combo Lab</a><a className="active" href="#/results"><CheckCircle2 size={15}/>Results</a></nav>
        <div className={`mode-pill ${supabase ? 'live' : 'error'}`}><span className="pulse-dot"/>{supabase ? 'LIVE DATA' : 'NOT CONNECTED'}</div>
      </div>
    </header>

    <main className="results-main">
      <section className="hero compact-hero">
        <div><div className="eyebrow">LIVE TRACK RECORD</div><h2>Every EVE pick.<br/><span>Win or lose.</span></h2><p>Scanner picks and Combo Lab are tracked separately. This is forward/live performance, not the historical backtest.</p></div>
        <div className="hero-status"><Database size={19}/><div><strong>Results status</strong><span>{activeMessage}</span></div></div>
      </section>

      <div className="results-mode-switch">
        <button className={mode==='scanner'?'active':''} onClick={()=>setMode('scanner')}><Trophy size={16}/>Scanner Picks</button>
        <button className={mode==='combo'?'active':''} onClick={()=>setMode('combo')}><Layers3 size={16}/>Combo Lab Results</button>
      </div>

      {mode==='scanner' ? <>
        <section className="kpis results-kpis">
          <div className="kpi-card"><div className="kpi-icon"><CheckCircle2 size={18}/></div><div><span>Wins</span><strong>{wins}</strong><small>Settled wins</small></div></div>
          <div className="kpi-card"><div className="kpi-icon result-loss-icon"><XCircle size={18}/></div><div><span>Losses</span><strong>{losses}</strong><small>Settled losses</small></div></div>
          <div className="kpi-card"><div className="kpi-icon"><Trophy size={18}/></div><div><span>Win percentage</span><strong>{winRate==null?'—':`${winRate}%`}</strong><small>Wins ÷ settled</small></div></div>
          <div className="kpi-card"><div className="kpi-icon result-pending-icon"><Clock3 size={18}/></div><div><span>Pending</span><strong>{pending}</strong><small>Excluded from win %</small></div></div>
        </section>
        <section className="qualification-panel results-explainer"><div className="qualification-count"><CheckCircle2 size={20}/><strong>{settled.length} SETTLED PICKS · {rows.length} TOTAL LOGGED</strong></div><p>Only final calibrated Best Bets and Market Lab signals are counted. Missing data and upcoming games stay pending.</p></section>
        <section className="scanner-section"><div className="section-head"><div><div className="eyebrow">PICK-BY-PICK LOG</div><h3>Date · Event · Bet · Result</h3></div><div className="tabs results-tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>All</button><button className={filter==='win'?'active':''} onClick={()=>setFilter('win')}>Wins</button><button className={filter==='loss'?'active':''} onClick={()=>setFilter('loss')}>Losses</button><button className={filter==='pending'?'active':''} onClick={()=>setFilter('pending')}>Pending</button><button className={filter==='best_bets'?'active':''} onClick={()=>setFilter('best_bets')}>Best Bets</button><button className={filter==='market_lab'?'active':''} onClick={()=>setFilter('market_lab')}>Market Lab</button></div></div>
          {filtered.length?<div className="result-list">{filtered.map((row)=><article className="result-row-card" key={row.id}><div className="result-date"><span>{dateLabel(row.kickoffUtc)}</span><small>{row.country} · {row.league}</small></div><div className="result-event"><strong>{row.homeTeam} <i>vs</i> {row.awayTeam}</strong><small>{row.homeGoals!=null&&row.awayGoals!=null?`Final score ${row.homeGoals}-${row.awayGoals}`:row.fixtureStatus.toUpperCase()}</small></div><div className="result-bet"><span>{row.sourcePage==='best_bets'?'BEST BETS':'MARKET LAB'}</span><strong>{row.selection}</strong><small>EVE {row.confidence}% · Grade {row.grade} · Data {row.dataQuality}%</small></div><div className={`result-outcome outcome-${row.outcome}`}><strong>{statusLabel(row.outcome)}</strong></div></article>)}</div>:<div className="empty-state"><Database size={21}/><span>No results match this filter yet.</span></div>}
        </section>
      </> : <>
        <section className="kpis results-kpis combo-kpis">
          <div className="kpi-card"><div className="kpi-icon"><CheckCircle2 size={18}/></div><div><span>Singles win %</span><strong>{singles.rate==null?'—':`${singles.rate}%`}</strong><small>{singles.wins}/{singles.settled} settled</small></div></div>
          <div className="kpi-card"><div className="kpi-icon"><Layers3 size={18}/></div><div><span>Doubles win %</span><strong>{doubles.rate==null?'—':`${doubles.rate}%`}</strong><small>{doubles.wins}/{doubles.settled} settled</small></div></div>
          <div className="kpi-card"><div className="kpi-icon"><Trophy size={18}/></div><div><span>Trebles win %</span><strong>{trebles.rate==null?'—':`${trebles.rate}%`}</strong><small>{trebles.wins}/{trebles.settled} settled</small></div></div>
          <div className="kpi-card"><div className="kpi-icon result-pending-icon"><Clock3 size={18}/></div><div><span>Combo pending</span><strong>{comboPending}</strong><small>Excluded from win %</small></div></div>
        </section>
        <section className="qualification-panel results-explainer"><div className="qualification-count"><Layers3 size={20}/><strong>{comboSettled.length} SETTLED COMBOS · {comboRows.length} TOTAL TRACKED</strong></div><p>Combo Lab has its own record. Singles, doubles and trebles are not mixed into the normal scanner win percentage. Overall Combo Lab settled win rate: <strong>{pct(comboWins,comboSettled.length)==null?'—':`${pct(comboWins,comboSettled.length)}%`}</strong>.</p><div className="qualification-rule"><Database size={17}/><span><strong>Rule:</strong> a double or treble wins only when every leg lands. Historical combo probability is the empirical joint rate EVE showed when the combo was frozen.</span></div></section>
        <section className="scanner-section"><div className="section-head"><div><div className="eyebrow">COMBO-BY-COMBO LOG</div><h3>Singles · Doubles · Trebles</h3></div><div className="tabs results-tabs"><button className={comboFilter==='all'?'active':''} onClick={()=>setComboFilter('all')}>All</button><button className={comboFilter==='single'?'active':''} onClick={()=>setComboFilter('single')}>Singles</button><button className={comboFilter==='double'?'active':''} onClick={()=>setComboFilter('double')}>Doubles</button><button className={comboFilter==='treble'?'active':''} onClick={()=>setComboFilter('treble')}>Trebles</button><button className={comboFilter==='win'?'active':''} onClick={()=>setComboFilter('win')}>Wins</button><button className={comboFilter==='loss'?'active':''} onClick={()=>setComboFilter('loss')}>Losses</button><button className={comboFilter==='pending'?'active':''} onClick={()=>setComboFilter('pending')}>Pending</button></div></div>
          {filteredCombos.length?<div className="result-list">{filteredCombos.map((row)=><article className="result-row-card" key={row.id}><div className="result-date"><span>{dateLabel(row.kickoffUtc)}</span><small>{row.country} · {row.league}</small></div><div className="result-event"><strong>{row.homeTeam} <i>vs</i> {row.awayTeam}</strong><small>{row.homeGoals!=null&&row.awayGoals!=null?`Final score ${row.homeGoals}-${row.awayGoals}`:row.fixtureStatus.toUpperCase()}</small></div><div className="result-bet combo-result-bet"><span>{row.comboType.toUpperCase()}</span><strong>{(row.legLabels??[]).join(' + ')}</strong><small>Historical joint rate {row.historicalProbability==null?'—':`${Number(row.historicalProbability).toFixed(1)}%`} · Sample {row.sampleSize} · Data {row.dataQuality}%</small></div><div className={`result-outcome outcome-${row.outcome}`}><strong>{statusLabel(row.outcome)}</strong></div></article>)}</div>:<div className="empty-state"><Database size={21}/><span>{comboMessage}</span></div>}
        </section>
      </>}
    </main>
    <footer>EVE Football Scanner · Scanner and Combo Lab tracked separately · Pending results excluded from win percentages</footer>
  </div>
}
