import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Activity,
  BarChart3,
  CheckCircle2,
  CircleDollarSign,
  Database,
  Flag,
  Goal,
  Layers3,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trophy,
  UserRoundCheck,
  Users,
} from 'lucide-react'

type CoreMarket = 'cards' | 'corners' | 'goals'
type Grade = 'A+' | 'A' | 'B' | 'C'
type ValueStatus = 'strong' | 'value' | 'no_value' | 'waiting' | 'uncalibrated'
type Page = 'best' | 'markets' | 'setup' | 'combos'
type Evidence = { key: string; label: string; display: string; score: number }

type Pick = {
  id: string
  fixtureId?: string
  country: string
  league: string
  homeTeam: string
  awayTeam: string
  kickoff: string
  kickoffUtc?: string | null
  market: CoreMarket
  selection: string
  confidence: number
  grade: Grade
  dataQuality: number
  evidence: Evidence[]
  referee?: { name: string; cardsPerMatch: number; foulsPerMatch?: number }
  fairProbability?: number | null
  fairOdds?: number | null
  bestBookmaker?: string | null
  bestOdds?: number | null
  edgePct?: number | null
  expectedValuePct?: number | null
  valueStatus?: ValueStatus | null
}

type ExpandedSignal = {
  id: string
  fixtureId: string
  country: string
  league: string
  homeTeam: string
  awayTeam: string
  kickoff: string
  kickoffUtc?: string | null
  market: string
  selection: string
  confidence: number
  grade: Grade
  dataQuality: number
  evidence: Evidence[]
  selectionKey: string
  features: Record<string, unknown>
  referee?: { name: string; cardsPerMatch?: number; matchesSample?: number } | null
  lineupsConfirmed: boolean
  refereeConfirmed: boolean
  fairProbability?: number | null
  fairOdds?: number | null
  bestBookmaker?: string | null
  bestOdds?: number | null
  edgePct?: number | null
  expectedValuePct?: number | null
  valueStatus?: ValueStatus | null
}

type SetupFixture = {
  fixtureId: string
  country: string
  league: string
  homeTeamId: string
  homeTeam: string
  awayTeamId: string
  awayTeam: string
  kickoff: string
  referee?: string | null
  refereeConfirmed: boolean
  lineupsConfirmed: boolean
  homeStarters: number
  awayStarters: number
}

type RefereeContext = {
  ok: boolean
  confirmed: boolean
  name?: string | null
  historicalIdentity?: string | null
  profile?: {
    matchesSample: number
    yellowCardsPerMatch?: number | null
    redCardsPerMatch?: number | null
    foulsPerMatch?: number | null
    penaltiesPerMatch?: number | null
    homeYellowsPerMatch?: number | null
    awayYellowsPerMatch?: number | null
    asOfDate?: string | null
  } | null
  tendency?: { level: string; impact: string }
  sampleLabel?: string
  modelUse?: string
}

type PlayerOutlook = {
  fixtureId: string
  teamId: string
  teamName: string
  playerId: string
  name: string
  position?: string | null
  isStarting: boolean
  matchesSample?: number | null
  avgMinutes?: number | null
  avgShots?: number | null
  avgShotsOnTarget?: number | null
  avgGoals?: number | null
  avgYellowCards?: number | null
}

type Combo = {
  id: string
  fixtureId: string
  country: string
  league: string
  homeTeam: string
  awayTeam: string
  kickoff: string
  sampleSize: number
  singles: Array<{ selection: string; probability: number; eveScore?: number; hits?: number; sample?: number }>
  doubles: Array<{ legs: string[]; probability: number; hits?: number; sample?: number }>
  treble?: { legs: string[]; probability: number; hits?: number; sample?: number } | null
  explanation?: string
  dataQuality: number
}

const coreMeta = {
  cards: { label: 'Yellow Cards', icon: ShieldCheck },
  corners: { label: 'Corners', icon: Flag },
  goals: { label: 'Goals', icon: Goal },
}

const expandedLabels: Record<string, string> = {
  btts: 'Both Teams To Score',
  team_goals: 'Team Goals',
  half_goals: 'Goals By Half',
  match_cards: 'Overall Match Cards',
  match_corners: 'Overall Match Corners',
}

const LONDON = 'Europe/London'

function pageFromHash(): Page {
  const value = window.location.hash.replace(/^#\/?/, '')
  return ['best', 'markets', 'setup', 'combos'].includes(value) ? value as Page : 'best'
}

function parsedDate(value?: string | null) {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function londonParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour') }
}

function londonDayIndex(date: Date) {
  const p = londonParts(date)
  return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000)
}

function dayDiff(value?: string | null) {
  const date = parsedDate(value)
  if (!date) return null
  return londonDayIndex(date) - londonDayIndex(new Date())
}

function inPreferredWindow(value?: string | null) {
  const date = parsedDate(value)
  if (!date) return true
  const diff = dayDiff(value)
  if (diff == null || diff < 0 || diff > 4) return false
  return date.getTime() >= Date.now() - 3 * 3600000
}

function kickoffSort(value?: string | null) {
  const date = parsedDate(value)
  return date ? date.getTime() : Number.MAX_SAFE_INTEGER
}

function eventDateLabel(value?: string | null, fallback = '') {
  const date = parsedDate(value)
  if (!date) return fallback
  const diff = dayDiff(value)
  const dateText = date.toLocaleDateString('en-GB', { timeZone: LONDON, weekday: 'short', day: '2-digit', month: 'short' })
  const timeText = date.toLocaleTimeString('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', hour12: false })
  const hour = londonParts(date).hour
  if (diff === 0) return `${hour >= 17 ? 'TONIGHT' : 'TODAY'} · ${dateText} · ${timeText}`
  if (diff === 1) return `TOMORROW · ${dateText} · ${timeText}`
  if (diff != null && diff >= 2 && diff <= 4) return `${dateText} · ${timeText} · IN ${diff} DAYS`
  return `${dateText} · ${timeText}`
}

function hoursUntil(value: string) {
  const date = parsedDate(value)
  return date ? (date.getTime() - Date.now()) / 3600000 : 999
}

function formatMaybe(value?: number | null, digits = 1) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits)
}

function App() {
  const [page, setPage] = useState<Page>(pageFromHash)
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
  const supabase = useMemo(() => url && key ? createClient(url, key) : null, [url, key])

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (next: Page) => {
    window.location.hash = `/${next}`
    setPage(next)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-row">
          <div className="brand-mark"><Activity size={22} /></div>
          <div><div className="eyebrow">EVE ANALYTICS</div><h1>Football Scanner</h1></div>
        </div>
        <div className="header-right">
          <nav className="page-nav">
            <button className={page === 'best' ? 'active' : ''} onClick={() => go('best')}><Trophy size={15}/>Best Bets</button>
            <button className={page === 'markets' ? 'active' : ''} onClick={() => go('markets')}><BarChart3 size={15}/>Market Lab</button>
            <button className={page === 'setup' ? 'active' : ''} onClick={() => go('setup')}><Users size={15}/>Match Setup</button>
            <button className={page === 'combos' ? 'active' : ''} onClick={() => go('combos')}><Layers3 size={15}/>Combo Lab</button>
          </nav>
          <div className={`mode-pill ${supabase ? 'live' : 'error'}`}><span className="pulse-dot" />{supabase ? 'LIVE DATA' : 'NOT CONNECTED'}</div>
        </div>
      </header>

      <main>
        {page === 'best' && <BestBetsPage supabase={supabase} />}
        {page === 'markets' && <MarketLabPage supabase={supabase} />}
        {page === 'setup' && <MatchSetupPage supabase={supabase} />}
        {page === 'combos' && <ComboLabPage supabase={supabase} />}
      </main>
      <footer>EVE Football Scanner · Next 4 days prioritised · Rolling historical evidence · Home/Away aware · Value filtered</footer>
    </div>
  )
}

function BestBetsPage({ supabase }: { supabase: any }) {
  const [activeMarket, setActiveMarket] = useState<'all' | CoreMarket>('all')
  const [picks, setPicks] = useState<Pick[]>([])
  const [message, setMessage] = useState('Loading the calibrated shortlist…')

  useEffect(() => {
    if (!supabase) { setMessage('Supabase is not connected'); return }
    supabase.from('scanner_best_bets').select('*').order('confidence', { ascending: false }).limit(80).then(({ data, error }: any) => {
      if (error) { setMessage(`Scanner view error: ${error.message}`); return }
      const rows = ((data ?? []) as Pick[]).filter((p) => inPreferredWindow(p.kickoffUtc)).sort((a,b) => kickoffSort(a.kickoffUtc)-kickoffSort(b.kickoffUtc) || b.confidence-a.confidence)
      setPicks(rows)
      setMessage(rows.length ? `${rows.length} calibrated candidates in the next 4 days` : 'No calibrated candidates in the next 4 days')
    })
  }, [supabase])

  const filtered = useMemo(() => picks.filter((p) => activeMarket === 'all' || p.market === activeMarket), [activeMarket,picks])
  const topScore = picks.length ? Math.max(...picks.map((p) => p.confidence)) : 0
  const averageQuality = picks.length ? Math.round(picks.reduce((s,p) => s+p.dataQuality,0)/picks.length) : 0
  const valueCount = picks.filter((p) => p.valueStatus === 'value' || p.valueStatus === 'strong').length

  return <>
    <section className="hero compact-hero">
      <div><div className="eyebrow">CALIBRATED LIVE SHORTLIST</div><h2>Strongest candidates.<br/><span>Then check the price.</span></h2><p>EVE prioritises tonight and the next four calendar days, while completed matches continuously roll into the next analysis.</p></div>
      <div className="hero-status"><Database size={19}/><div><strong>Data status</strong><span>{message}</span></div></div>
    </section>

    <section className="kpis">
      <Kpi icon={Trophy} label="Qualified candidates" value={String(picks.length)} detail="Next 4 days" />
      <Kpi icon={Sparkles} label="Top EVE score" value={`${topScore}%`} detail="Statistical score" />
      <Kpi icon={Database} label="Data quality" value={`${averageQuality}%`} detail="Coverage score" />
      <Kpi icon={CircleDollarSign} label="Value bets now" value={String(valueCount)} detail="VALUE / STRONG only" />
    </section>

    <section className="qualification-panel">
      <div className="qualification-count"><Trophy size={20}/><strong>{picks.length} QUALIFIED IN THE NEXT 4 DAYS</strong></div>
      <p>EVE analyses all supported upcoming fixtures, but this screen deliberately concentrates on the matches you can actually act on now. <strong>Every event carries its date and time, with tonight/tomorrow highlighted.</strong></p>
      <div className="qualification-rule"><CircleDollarSign size={17}/><span><strong>Final betting rule:</strong> VALUE or STRONG VALUE = candidate. NO VALUE = skip. WAITING PRICE = no decision yet.</span></div>
    </section>

    <section className="scanner-section">
      <div className="section-head"><div><div className="eyebrow">CURRENT QUALIFIERS</div><h3>Best Bets shortlist</h3></div><div className="tabs"><button className={activeMarket==='all'?'active':''} onClick={()=>setActiveMarket('all')}>All</button>{(Object.keys(coreMeta) as CoreMarket[]).map((m)=>{const Icon=coreMeta[m].icon;return <button key={m} className={activeMarket===m?'active':''} onClick={()=>setActiveMarket(m)}><Icon size={15}/>{coreMeta[m].label}</button>})}</div></div>
      {filtered.length ? <div className="pick-grid">{filtered.map((pick,i)=><PickCard key={pick.id} pick={pick} rank={i+1}/>)}</div> : <Empty text="Nothing currently passes the calibrated shortlist inside the next four days."/>}
    </section>
  </>
}

function MarketLabPage({ supabase }: { supabase: any }) {
  const [signals,setSignals]=useState<ExpandedSignal[]>([])
  const [filter,setFilter]=useState('all')
  const [message,setMessage]=useState('Loading calibrated expanded markets…')
  useEffect(()=>{
    if(!supabase){setMessage('Supabase is not connected');return}
    supabase.from('scanner_expanded_markets').select('*').order('confidence',{ascending:false}).limit(140).then(({data,error}:any)=>{
      if(error){setMessage(`Expanded value view not ready: ${error.message}`);return}
      const rows=((data??[]) as ExpandedSignal[]).filter((s)=>inPreferredWindow(s.kickoffUtc)).sort((a,b)=>kickoffSort(a.kickoffUtc)-kickoffSort(b.kickoffUtc)||b.confidence-a.confidence)
      setSignals(rows);setMessage(`${rows.length} calibrated expanded signals in the next 4 days`)
    })
  },[supabase])
  const filtered=signals.filter((s)=>filter==='all'||s.market===filter)
  const marketNames=[...new Set(signals.map((s)=>s.market))]
  const valueCount=signals.filter((s)=>s.valueStatus==='value'||s.valueStatus==='strong').length
  return <>
    <PageIntro eyebrow="EXPANDED MARKET LAB" title="Calibrated signals. Then check the price." text="BTTS, goals per team, goals by half, overall match cards and overall match corners — prioritised from tonight through the next four days." status={message}/>
    <section className="info-panel"><CheckCircle2 size={18}/><div><strong>Home/Away differentiation is built in.</strong><span>If a team is at home, EVE weights its home-only history against the opponent's away-only history. Recent 10, season form, H2H, referee and confirmed starting XI context are layered around that venue split.</span></div></section>
    <section className="research-panel"><strong>2026/27 out-of-sample validation</strong><span>These markets passed their 2025/26 walk-forward calibration, but remain in Market Lab while the new season validates them. Current value flags: <strong>{valueCount}</strong>. VALUE / STRONG VALUE means the current bookmaker price clears EVE's conservative edge and EV rules; NO VALUE means skip at that price.</span></section>
    <div className="tabs wide-tabs"><button className={filter==='all'?'active':''} onClick={()=>setFilter('all')}>All</button>{marketNames.map((m)=><button key={m} className={filter===m?'active':''} onClick={()=>setFilter(m)}>{expandedLabels[m]??m}</button>)}</div>
    {filtered.length ? <div className="pick-grid expanded-grid">{filtered.map((s)=><ExpandedCard key={s.id} signal={s}/>)}</div> : <Empty text="No calibrated expanded signals currently qualify inside the next four days."/>}
  </>
}

function MatchSetupPage({ supabase }: { supabase:any }) {
  const [fixtures,setFixtures]=useState<SetupFixture[]>([])
  const [selectedId,setSelectedId]=useState('')
  const [referee,setReferee]=useState('')
  const [refIntel,setRefIntel]=useState<RefereeContext|null>(null)
  const [homeText,setHomeText]=useState('')
  const [awayText,setAwayText]=useState('')
  const [players,setPlayers]=useState<PlayerOutlook[]>([])
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState(false)
  const [manualOpen,setManualOpen]=useState(false)

  const loadFixtures=async()=>{
    if(!supabase)return
    const {data,error}=await supabase.from('fixture_setup_board').select('*').order('kickoff',{ascending:true}).limit(160)
    if(error){setNotice(`Match Setup data error: ${error.message}`);return}
    const rows=((data??[]) as SetupFixture[]).filter((f)=>inPreferredWindow(f.kickoff)).sort((a,b)=>kickoffSort(a.kickoff)-kickoffSort(b.kickoff))
    setFixtures(rows)
    setSelectedId((current)=>current&&rows.some((f)=>f.fixtureId===current)?current:(rows[0]?.fixtureId??''))
  }

  useEffect(()=>{
    if(!supabase)return
    void loadFixtures()
    const timer=window.setInterval(()=>void loadFixtures(),60000)
    return()=>window.clearInterval(timer)
  },[supabase])

  const selected=fixtures.find((f)=>f.fixtureId===selectedId)

  useEffect(()=>{
    setManualOpen(false)
    setNotice('')
    setRefIntel(null)
  },[selectedId])

  useEffect(()=>{
    if(!selectedId){setRefIntel(null);return}
    let cancelled=false
    const loadRef=async()=>{
      try{
        const response=await fetch(`/.netlify/functions/referee-context?fixture_id=${encodeURIComponent(selectedId)}`,{cache:'no-store'})
        const result=await response.json()
        if(!cancelled)setRefIntel(response.ok&&result.ok?result:null)
      }catch{if(!cancelled)setRefIntel(null)}
    }
    void loadRef()
    const timer=window.setInterval(()=>void loadRef(),60000)
    return()=>{cancelled=true;window.clearInterval(timer)}
  },[selectedId])

  useEffect(()=>{
    if(!supabase||!selectedId){setPlayers([]);return}
    let cancelled=false
    const load=async()=>{
      const current=fixtures.find((f)=>f.fixtureId===selectedId)
      const {data}=await supabase.from('fixture_player_outlook').select('*').eq('fixtureId',selectedId).order('teamName').order('name')
      if(cancelled)return
      const rows=(data??[]) as PlayerOutlook[]
      setPlayers(rows)
      if(!manualOpen&&current){
        setReferee(refIntel?.name??current.referee??'')
        const home=rows.filter((p)=>p.teamId===current.homeTeamId).map((p)=>p.name)
        const away=rows.filter((p)=>p.teamId===current.awayTeamId).map((p)=>p.name)
        setHomeText(home.join('\n'))
        setAwayText(away.join('\n'))
      }
    }
    void load()
    const timer=window.setInterval(()=>void load(),60000)
    return()=>{cancelled=true;window.clearInterval(timer)}
  },[supabase,selectedId,fixtures,manualOpen,refIntel?.name])

  const split=(text:string)=>text.split('\n').map((x)=>x.trim()).filter(Boolean)
  const confirm=async()=>{
    if(!selected)return
    setBusy(true);setNotice('Saving manual override and re-running EVE on this fixture…')
    try{
      const response=await fetch('/.netlify/functions/confirm-match-context',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({fixtureId:selected.fixtureId,refereeName:referee,homeLineup:split(homeText),awayLineup:split(awayText),notes:'Manual override from Match Setup'})})
      const result=await response.json()
      if(!response.ok||!result.ok)throw new Error(result.error??'Confirmation failed')
      setNotice(result.message)
      await loadFixtures()
      const {data}=await supabase.from('fixture_player_outlook').select('*').eq('fixtureId',selected.fixtureId).order('teamName').order('name')
      setPlayers((data??[]) as PlayerOutlook[])
    }catch(error){setNotice(error instanceof Error?error.message:String(error))}finally{setBusy(false)}
  }

  const setupStatus=selected?matchdayStatus(selected):'Select a fixture. EVE scans every supported fixture in the next four days once per hour.'
  const homeCount=split(homeText).length,awayCount=split(awayText).length
  const autoActive=selected?hoursUntil(selected.kickoff)<=96&&hoursUntil(selected.kickoff)>=-3:false
  const refProfile=refIntel?.profile

  return <>
    <PageIntro eyebrow="HOURLY PRE-MATCH INTELLIGENCE" title="Referee + Starting XI intelligence" text="EVE scans every supported fixture in the next four days once per hour. As soon as referee or official 11+11 data becomes available it is imported, linked to historical referee/player evidence, and any material change triggers a fresh model calculation." status={notice||setupStatus}/>
    <section className="setup-card">
      <label>Fixture<select value={selectedId} onChange={(e)=>setSelectedId(e.target.value)}><option value="">Select fixture</option>{fixtures.map((f)=><option key={f.fixtureId} value={f.fixtureId}>{eventDateLabel(f.kickoff)} · {f.homeTeam} v {f.awayTeam}</option>)}</select></label>
      {selected&&<>
        <div className="fixture-heading"><div><span>{selected.country} · {selected.league}</span><strong>{selected.homeTeam} vs {selected.awayTeam}</strong><div className="event-date compact-date">{eventDateLabel(selected.kickoff)}</div></div><div className="context-badges"><i className={selected.refereeConfirmed?'ok':''}>REF {selected.refereeConfirmed?'CONFIRMED':'WAITING'}</i><i className={selected.lineupsConfirmed?'ok':''}>XI {selected.lineupsConfirmed?'CONFIRMED':'WAITING'}</i></div></div>

        <div className="matchday-status-panel">
          <div className="matchday-row"><span>Referee</span><strong className={selected.refereeConfirmed?'confirmed-text':'waiting-text'}>{selected.refereeConfirmed?(refIntel?.name??selected.referee??'Confirmed'):'Awaiting referee confirmation'}</strong></div>
          <div className="matchday-row"><span>Starting XIs</span><strong className={selected.lineupsConfirmed?'confirmed-text':'waiting-text'}>{selected.lineupsConfirmed?`CONFIRMED · ${selected.homeStarters} + ${selected.awayStarters} starters`:'AWAITING LINEUP CONFIRMATION'}</strong></div>
          <div className="matchday-row"><span>Automatic checks</span><strong className={autoActive?'active-text':''}>{selected.refereeConfirmed&&selected.lineupsConfirmed?'DATA COMPLETE · HOURLY WATCH ON':autoActive?'ACTIVE · HOURLY PRE-MATCH SCAN':'OUTSIDE 4-DAY SCAN WINDOW'}</strong></div>
          <p>{selected.lineupsConfirmed?'Official starting teams are loaded. EVE keeps the hourly watch active and re-runs the fixture if material match information changes.':'EVE checks this fixture every hour. A referee is imported as soon as the provider publishes him; official lineups are imported when released. New material information automatically feeds back into Best Bets, Market Lab, calibration and Combo Lab.'}</p>
        </div>

        {selected.refereeConfirmed&&<div className="matchday-status-panel">
          <div className="matchday-row"><span>Referee tendency</span><strong>{refIntel?.tendency?.level??'CHECKING HISTORY'}</strong></div>
          <div className="matchday-row"><span>Historical sample</span><strong>{refProfile?`${refProfile.matchesSample} matches · ${refIntel?.sampleLabel??''}`:'Awaiting a usable historical profile'}</strong></div>
          <div className="matchday-row"><span>Yellow cards</span><strong>{refProfile?`${formatMaybe(refProfile.yellowCardsPerMatch,2)} / match`:'—'}</strong></div>
          <div className="matchday-row"><span>Red cards</span><strong>{refProfile?`${formatMaybe(refProfile.redCardsPerMatch,3)} / match`:'—'}</strong></div>
          <div className="matchday-row"><span>Fouls</span><strong>{refProfile?`${formatMaybe(refProfile.foulsPerMatch,1)} / match`:'—'}</strong></div>
          <div className="matchday-row"><span>Home / away yellows</span><strong>{refProfile?`${formatMaybe(refProfile.homeYellowsPerMatch,2)} / ${formatMaybe(refProfile.awayYellowsPerMatch,2)}`:'—'}</strong></div>
          {refProfile?.penaltiesPerMatch!=null&&<div className="matchday-row"><span>Penalties</span><strong>{formatMaybe(refProfile.penaltiesPerMatch,3)} / match</strong></div>}
          <p><strong>Card-model impact:</strong> {refIntel?.tendency?.impact??'EVE will keep referee influence neutral until enough historical evidence is linked.'}</p>
        </div>}

        <button className="manual-toggle" onClick={()=>setManualOpen((v)=>!v)}>{manualOpen?'Hide manual override':'Manual override'}</button>
        {manualOpen&&<div className="manual-override">
          <div className="override-note">Only use this if the automatic provider is late or wrong. Official auto-imported data will normally be used.</div>
          <label>Referee<input value={referee} onChange={(e)=>setReferee(e.target.value)} placeholder="e.g. Michael Oliver"/></label>
          <div className="lineup-grid">
            <label>{selected.homeTeam} starting XI <span>{homeCount}/11</span><textarea value={homeText} onChange={(e)=>setHomeText(e.target.value)} placeholder="One player per line" rows={13}/></label>
            <label>{selected.awayTeam} starting XI <span>{awayCount}/11</span><textarea value={awayText} onChange={(e)=>setAwayText(e.target.value)} placeholder="One player per line" rows={13}/></label>
          </div>
          <button className="primary-action" disabled={busy} onClick={confirm}>{busy?<RefreshCw className="spin" size={17}/>:<CheckCircle2 size={17}/>}Save manual override & Reanalyse</button>
        </div>}
      </>}
    </section>

    {selected&&<section className="player-section"><div className="section-head"><div><div className="eyebrow">PLAYER HISTORY</div><h3>Starting XI form used by EVE</h3></div></div>{players.length?<div className="player-tables"><PlayerTable team={selected.homeTeam} rows={players.filter((p)=>p.teamId===selected.homeTeamId)}/><PlayerTable team={selected.awayTeam} rows={players.filter((p)=>p.teamId===selected.awayTeamId)}/></div>:<Empty text="Awaiting lineup confirmation. When the official starting teams are published, EVE will import all 22 starters automatically and attach the player history it has collected."/>}</section>}
  </>
}

function matchdayStatus(fixture:SetupFixture){
  if(fixture.refereeConfirmed&&fixture.lineupsConfirmed)return'Match data complete — referee and both starting XIs are loaded; hourly watch remains active.'
  const hours=hoursUntil(fixture.kickoff)
  if(hours<=96&&hours>=-3)return fixture.lineupsConfirmed?'Starting XIs confirmed — hourly scan remains active for referee and match updates.':'Hourly pre-match intelligence scan is active for this fixture.'
  return 'Pre-match analysis ready — hourly intelligence scanning starts four days before kickoff.'
}

function ComboLabPage({supabase}:{supabase:any}){
  const [combos,setCombos]=useState<Combo[]>([])
  const [message,setMessage]=useState('Loading same-game analysis…')
  useEffect(()=>{
    if(!supabase){setMessage('Supabase is not connected');return}
    supabase.from('combo_board').select('*').order('kickoff',{ascending:true}).limit(100).then(({data,error}:any)=>{
      if(error){setMessage(`Combo view error: ${error.message}`);return}
      const rows=((data??[]) as Combo[]).filter((c)=>inPreferredWindow(c.kickoff)).sort((a,b)=>kickoffSort(a.kickoff)-kickoffSort(b.kickoff))
      setCombos(rows);setMessage(`${rows.length} matches with empirical combo analysis in the next 4 days`)
    })
  },[supabase])
  return <>
    <PageIntro eyebrow="SAME-GAME COMBINATION ENGINE" title="Singles, doubles and trebles" text="EVE measures how often the legs actually occurred together in comparable historical home/away matches. Tonight and the next four days are prioritised." status={message}/>
    <section className="info-panel"><Layers3 size={18}/><div><strong>How to read this page</strong><span>Each single has its own historical joint-sample rate. Every two-leg combination gets a separate measured percentage. If three usable legs exist, EVE also shows the all-three treble rate.</span></div></section>
    {combos.length?<div className="combo-grid">{combos.map((c)=><ComboCard key={c.id} combo={c}/>)}</div>:<Empty text="No combo analysis currently falls inside the next four days."/>}
  </>
}

function PageIntro({eyebrow,title,text,status}:{eyebrow:string;title:string;text:string;status:string}){
  return <section className="hero compact-hero"><div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2><p>{text}</p></div><div className="hero-status"><Database size={19}/><div><strong>Status</strong><span>{status}</span></div></div></section>
}
function Kpi({icon:Icon,label,value,detail}:{icon:typeof Activity;label:string;value:string;detail:string}){return <div className="kpi-card"><div className="kpi-icon"><Icon size={18}/></div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>}
function Empty({text}:{text:string}){return <div className="empty-state"><Database size={21}/><span>{text}</span></div>}
function valueLabel(status?:ValueStatus|null){if(status==='strong')return'STRONG VALUE';if(status==='value')return'VALUE';if(status==='no_value')return'NO VALUE — SKIP';if(status==='waiting')return'WAITING PRICE';return'WAITING CALIBRATION'}

function PickCard({pick,rank}:{pick:Pick;rank:number}){
  const Icon=coreMeta[pick.market].icon
  return <article className="pick-card"><div className="pick-top"><div className="rank">#{rank}</div><div className={`grade grade-${pick.grade.replace('+','plus').toLowerCase()}`}>{pick.grade}</div></div><div className="league-line">{pick.country} · {pick.league}</div><div className="event-date">{eventDateLabel(pick.kickoffUtc,pick.kickoff)}</div><h4>{pick.homeTeam} <span>vs</span> {pick.awayTeam}</h4><div className="selection"><Icon size={17}/><span>{pick.selection}</span></div>
    {pick.valueStatus&&<div className={`value-strip value-${pick.valueStatus}`}><div><CircleDollarSign size={16}/><strong>{valueLabel(pick.valueStatus)}</strong></div><span>{pick.bestOdds?`${pick.bestBookmaker??'Best price'} ${Number(pick.bestOdds).toFixed(2)}`:'No compatible price available yet'}</span></div>}
    <div className="confidence-row"><span>EVE statistical score</span><strong>{pick.confidence}%</strong></div><div className="meter"><i style={{width:`${pick.confidence}%`}}/></div>
    {(pick.fairOdds!=null||pick.bestOdds!=null)&&<div className="value-metrics"><Metric label="Fair odds" value={pick.fairOdds!=null?Number(pick.fairOdds).toFixed(2):'—'}/><Metric label="Best odds" value={pick.bestOdds!=null?Number(pick.bestOdds).toFixed(2):'—'}/><Metric label="Edge" value={pick.edgePct!=null?`${Number(pick.edgePct).toFixed(1)}%`:'—'}/><Metric label="EV" value={pick.expectedValuePct!=null?`${Number(pick.expectedValuePct).toFixed(1)}%`:'—'}/></div>}
    <EvidenceGrid evidence={pick.evidence??[]} id={pick.id}/>{pick.referee&&<div className="referee-line"><UserRoundCheck size={16}/><div><span>{pick.referee.name}</span><strong>{Number(pick.referee.cardsPerMatch??0).toFixed(1)} cards/match</strong></div></div>}<div className="quality-line"><span>Data quality</span><strong>{pick.dataQuality}%</strong></div></article>
}
function ExpandedCard({signal}:{signal:ExpandedSignal}){return <article className="pick-card expanded-card"><div className="pick-top"><div className="research-tag">OOS RESEARCH</div><div className={`grade grade-${signal.grade.replace('+','plus').toLowerCase()}`}>{signal.grade}</div></div><div className="league-line">{signal.country} · {signal.league}</div><div className="event-date">{eventDateLabel(signal.kickoffUtc,signal.kickoff)}</div><h4>{signal.homeTeam} <span>vs</span> {signal.awayTeam}</h4><div className="selection"><BarChart3 size={17}/><span>{signal.selection}</span></div>
  {signal.valueStatus&&<div className={`value-strip value-${signal.valueStatus}`}><div><CircleDollarSign size={16}/><strong>{valueLabel(signal.valueStatus)}</strong></div><span>{signal.bestOdds?`${signal.bestBookmaker??'Best price'} ${Number(signal.bestOdds).toFixed(2)}`:'No compatible price available yet'}</span></div>}
  <div className="context-badges inline-badges"><i className={signal.refereeConfirmed?'ok':''}>REF</i><i className={signal.lineupsConfirmed?'ok':''}>XI</i></div><div className="confidence-row"><span>EVE calibrated score</span><strong>{signal.confidence}%</strong></div><div className="meter"><i style={{width:`${signal.confidence}%`}}/></div>
  {(signal.fairOdds!=null||signal.bestOdds!=null)&&<div className="value-metrics"><Metric label="Fair odds" value={signal.fairOdds!=null?Number(signal.fairOdds).toFixed(2):'—'}/><Metric label="Best odds" value={signal.bestOdds!=null?Number(signal.bestOdds).toFixed(2):'—'}/><Metric label="Edge" value={signal.edgePct!=null?`${Number(signal.edgePct).toFixed(1)}%`:'—'}/><Metric label="EV" value={signal.expectedValuePct!=null?`${Number(signal.expectedValuePct).toFixed(1)}%`:'—'}/></div>}
  <EvidenceGrid evidence={signal.evidence??[]} id={signal.id}/><div className="quality-line"><span>Data quality</span><strong>{signal.dataQuality}%</strong></div></article>}
function EvidenceGrid({evidence,id}:{evidence:Evidence[];id:string}){return <div className="evidence-grid">{evidence.map((e)=><div className="evidence" key={`${id}-${e.key}`}><span>{e.label}</span><strong>{e.display}</strong><small>{e.score}/100 factor</small></div>)}</div>}
function Metric({label,value}:{label:string;value:string}){return <div><span>{label}</span><strong>{value}</strong></div>}
function PlayerTable({team,rows}:{team:string;rows:PlayerOutlook[]}){return <div className="player-table-wrap"><h4>{team}</h4><div className="player-table"><div className="player-row player-head"><span>Player</span><span>Matches</span><span>Shots</span><span>SOT</span><span>Goals</span><span>Cards</span></div>{rows.map((p)=><div className="player-row" key={p.playerId}><span><strong>{p.name}</strong><small>{p.position??'—'}</small></span><span>{p.matchesSample??0}</span><span>{p.avgShots??'—'}</span><span>{p.avgShotsOnTarget??'—'}</span><span>{p.avgGoals??'—'}</span><span>{p.avgYellowCards??'—'}</span></div>)}</div></div>}
function ComboCard({combo}:{combo:Combo}){return <article className="combo-card"><div className="league-line">{combo.country} · {combo.league}</div><div className="event-date">{eventDateLabel(combo.kickoff)}</div><h4>{combo.homeTeam} <span>vs</span> {combo.awayTeam}</h4><div className="combo-sample">Comparable home/away sample: <strong>{combo.sampleSize}</strong> · Data quality <strong>{combo.dataQuality}%</strong></div><h5>Single legs</h5>{combo.singles?.map((s,i)=><div className="prob-row" key={i}><span>{s.selection}</span><strong>{s.probability}%</strong></div>)}<h5>Two-leg combinations</h5>{combo.doubles?.map((d,i)=><div className="prob-row" key={i}><span>{d.legs.join(' + ')}</span><strong>{d.probability}%</strong></div>)}{combo.treble&&<><h5>All three</h5><div className="prob-row treble"><span>{combo.treble.legs.join(' + ')}</span><strong>{combo.treble.probability}%</strong></div></>}<p>{combo.explanation}</p></article>}

export default App