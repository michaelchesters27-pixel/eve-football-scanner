import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { Activity, BarChart3, CheckCircle2, Clock3, Database, Layers3, Trophy } from 'lucide-react'

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

type Filter = 'all' | 'win' | 'loss' | 'pending' | 'grade_a' | 'grade_a_plus'
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
      const bestBetCount=resultRows.filter((row)=>row.sourcePage==='best_bets').length
      setMessage(bestBetCount ? `${bestBetCount} final Best Bets permanently logged` : 'No final Best Bets logged yet')
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

  const bestBetRows = rows.filter((r) => r.sourcePage === 'best_bets')
  const settled = bestBetRows.filter((r) => r.outcome === 'win' || r.outcome === 'loss')
  const wins = settled.filter((r) => r.outcome === 'win').length
  const losses = settled.filter((r) => r.outcome === 'loss').length
  const pending = bestBetRows.filter((r) => isPending(r.outcome)).length
  const winRate = pct(wins,settled.length)
  const gradeStats = (grade:string) => {
    const all=bestBetRows.filter((r)=>r.grade.toUpperCase()===grade)
    const gradeSettled=all.filter((r)=>r.outcome==='win'||r.outcome==='loss')
    const gradeWins=gradeSettled.filter((r)=>r.outcome==='win').length
    return { all:all.length, settled:gradeSettled.length, wins:gradeWins, rate:pct(gradeWins,gradeSettled.length) }
  }
  const gradeA=gradeStats('A'), gradeAPlus=gradeStats('A+')

  const filtered = bestBetRows.filter((r) => {
    if (filter === 'all') return true
    if (filter === 'pending') return isPending(r.outcome)
    if (filter === 'grade_a') return r.grade.toUpperCase() === 'A'
    if (filter === 'grade_a_plus') return r.grade.toUpperCase() === 'A+'
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
        <div><div className="eyebrow">LIVE TRACK RECORD</div><h2>Every EVE pick.<br/><span>Win or lose.</span></h2><p>Best Bets and Combo Lab are tracked separately. This is forward/live performance, not the historical backtest.</p></div>
        <div className="hero-status"><Database size={19}/><div><strong>Results status</strong><span>{activeMessage}</span></div></div>
      </section>

      <div className="results-mode-switch">
        <button className={mode==='scanner'?'active':''} onClick={()=>setMode('scanner')}><Trophy size={16}/>Best Bets Results</button>
        <button className={mode==='combo'?'active':''} onClick={()=>setMode('combo')}><Layers3 size={16}/>Combo Lab Results</button>
      </div>

      {mode==='scanner' ? <>
        <section className="kpis results-kpis">
          <div className="kpi-card grade-kpi grade-a-kpi"><div className="kpi-icon"><CheckCircle2 size={18}/></div><div><span>Grade A win %</span><strong>{gradeA.rate==null?'—':`${gradeA.rate}%`}</strong><small>{gradeA.wins}/{gradeA.settled} settled · {gradeA.all} logged</small></div></div>
          <div className="kpi-card grade-kpi grade-a-plus-kpi"><div className="kpi-icon"><Trophy size={18}/></div><div><span>Grade A+ win %</span><strong>{gradeAPlus.rate==null?'—':`${gradeAPlus.rate}%`}</strong><small>{gradeAPlus.wins}/{gradeAPlus.settled} settled · {gradeAPlus.all} logged</small></div></div>
          <div className="kpi-card"><div className="kpi-icon"><Trophy size={18}/></div><div><span>Overall win %</span><strong>{winRate==null?'—':`${winRate}%`}</strong><small>{wins} wins · {losses} losses</small></div></div>
          <div className="kpi-card"><div className="kpi-icon result-pending-icon"><Clock3 size={18}/></div><div><span>Best Bets pending</span><strong>{pending}</strong><small>Excluded from win %</small></div></div>
        </section>
        <section className="qualification-panel results-explainer"><div className="qualification-count"><CheckCircle2 size={20}/><strong>{settled.length} SETTLED BEST BETS · {bestBetRows.length} TOTAL LOGGED</strong></div><p>Only final calibrated picks actually published on the Best Bets page are counted here. Market Lab signals are not mixed into this record.</p><div className="qualification-rule"><Trophy size={17}/><span><strong>Grade comparison:</strong> Grade A and Grade A+ are tracked separately. Any grade with fewer than 10 settled bets is provisional.</span></div></section>
        <section className="scanner-section"><div className="section-head"><div><div className="eyebrow">BEST-BET-BY-BEST-BET LOG</div><h3>Grade A · Grade A+ · Result</h3></div><div className="tabs results-tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>All</button><button className={filter==='win'?'active':''} onClick={()=>setFilter('win')}>Wins</button><button className={filter==='loss'?'active':''} onClick={()=>setFilter('loss')}>Losses</button><button className={filter==='pending'?'active':''} onClick={()=>setFilter('pending')}>Pending</button><button className={filter==='grade_a'?'active':''} onClick={()=>setFilter('grade_a')}>Grade A</button><button className={filter==='grade_a_plus'?'active':''} onClick={()=>setFilter('grade_a_plus')}>Grade A+</button></div></div>
          {filtered.length?<div className="result-list">{filtered.map((row)=><article className="result-row-card" key={row.id}><div className="result-date"><span>{dateLabel(row.kickoffUtc)}</span><small>{row.country} · {row.league}</small></div><div className="result-event"><strong>{row.homeTeam} <i>vs</i> {row.awayTeam}</strong><small>{row.homeGoals!=null&&row.awayGoals!=null?`Final score ${row.homeGoals}-${row.awayGoals}`:row.fixtureStatus.toUpperCase()}</small></div><div className="result-bet"><div className="result-bet-tags"><span>BEST BETS</span><span className={`result-grade-badge ${row.grade.toUpperCase()==='A+'?'grade-a-plus':''}`}>GRADE {row.grade}</span></div><strong>{row.selection}</strong><small>EVE {row.confidence}% · Data {row.dataQuality}%</small></div><div className={`result-outcome outcome-${row.outcome}`}><strong>{statusLabel(row.outcome)}</strong></div></article>)}</div>:<div className="empty-state"><Database size={21}/><span>No Best Bet results match this filter yet.</span></div>}
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
    <footer>EVE Football Scanner · Best Bets and Combo Lab tracked separately · Grade A and A+ reported independently</footer>
  </div>
}
