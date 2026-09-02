import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CalendarDays,
  ChevronRight,
  Flame,
  Layers3,
  RefreshCw,
  Search,
  ShieldAlert,
  Trophy,
  Users,
} from 'lucide-react'

type Ranking = {
  referee_id: string
  name: string
  source_key: string
  as_of_date: string
  matches_sample: number
  yellow_cards_per_match: number
  red_cards_per_match: number | null
  fouls_per_match: number | null
  penalties_per_match: number | null
  home_yellows_per_match: number | null
  away_yellows_per_match: number | null
  profile_source: string
  recent_matches: number | null
  recent_yellows_per_match: number | null
  recent_reds_per_match: number | null
  recent_fouls_per_match: number | null
  recent_home_yellows_per_match: number | null
  recent_away_yellows_per_match: number | null
  latest_match_at: string | null
  upcoming_assignments: number
}

type AssignmentRow = {
  fixture_id: string
  kickoff: string
  referee_id: string
  referee_name: string
  referee_source_key: string
  league: string
  home_team: string
  away_team: string
}

type Assignment = {
  fixtureId: string
  kickoff: string
  homeTeam: string
  awayTeam: string
  league: string
}

type RefWatchRow = {
  id: string
  name: string
  sourceKey: string
  sample: number
  yellows: number
  reds: number
  fouls: number | null
  penalties: number | null
  homeYellows: number | null
  awayYellows: number | null
  source: string
  asOfDate: string
  aggression: number
  yellowIndex: number
  redIndex: number
  reliability: number
  recentMatches: number
  recentYellows: number | null
  recentReds: number | null
  recentFouls: number | null
  trend: 'RISING' | 'STEADY' | 'COOLING' | 'NEW'
  assignments: Assignment[]
}

type Filter = 'all' | 'upcoming' | 'yellow' | 'red'
type Sort = 'aggression' | 'yellow' | 'red' | 'sample' | 'recent'

const LONDON = 'Europe/London'

function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percentile(value: number, values: number[]) {
  if (values.length <= 1) return 1
  const sorted = [...values].sort((a, b) => a - b)
  const below = sorted.filter((v) => v < value).length
  const equal = sorted.filter((v) => v === value).length
  return Math.max(0, Math.min(1, (below + Math.max(0, equal - 1) / 2) / (sorted.length - 1)))
}

function shrink(value: number, sample: number, baseline: number) {
  const weight = sample / (sample + 12)
  return value * weight + baseline * (1 - weight)
}

function formatDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const today = new Date()
  const localDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(d)
  const sameDay = localDay(date) === localDay(today)
  const tomorrow = new Date(today.getTime() + 86400000)
  const isTomorrow = localDay(date) === localDay(tomorrow)
  const time = date.toLocaleTimeString('en-GB', { timeZone: LONDON, hour: '2-digit', minute: '2-digit', hour12: false })
  if (sameDay) return `TODAY · ${time}`
  if (isTomorrow) return `TOMORROW · ${time}`
  return `${date.toLocaleDateString('en-GB', { timeZone: LONDON, weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase()} · ${time}`
}

function severity(score: number) {
  if (score >= 90) return { label: 'EXTREME REF', className: 'extreme' }
  if (score >= 80) return { label: 'VERY HIGH', className: 'very-high' }
  if (score >= 65) return { label: 'HIGH CARD REF', className: 'high' }
  if (score >= 50) return { label: 'ABOVE AVERAGE', className: 'above' }
  return { label: 'STANDARD', className: 'standard' }
}

function redRisk(reds: number) {
  if (reds >= 0.22) return 'VERY HIGH'
  if (reds >= 0.14) return 'HIGH'
  if (reds >= 0.08) return 'MODERATE'
  return 'LOW'
}

function trendFor(row: Ranking): RefWatchRow['trend'] {
  const sample = Number(row.recent_matches ?? 0)
  if (sample < 3 || row.recent_yellows_per_match == null) return 'NEW'
  const delta = Number(row.recent_yellows_per_match) - Number(row.yellow_cards_per_match)
    + (Number(row.recent_reds_per_match ?? 0) - Number(row.red_cards_per_match ?? 0)) * 4
  if (delta >= 0.25) return 'RISING'
  if (delta <= -0.25) return 'COOLING'
  return 'STEADY'
}

export default function RefWatchSafePage() {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
  const supabase = useMemo(() => url && key ? createClient(url, key) : null, [url, key])
  const [rows, setRows] = useState<RefWatchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('Loading referee intelligence…')
  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('aggression')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    if (!supabase) {
      setLoading(false)
      setMessage('Supabase is not connected')
      return
    }

    let cancelled = false
    const load = async () => {
      setLoading(true)
      setMessage('Reading exact referee identities, confirmed assignments and recent form…')
      try {
        const [rankingResult, assignmentResult] = await Promise.all([
          supabase.from('ref_watch_rankings').select('*'),
          supabase.from('ref_watch_assignments').select('*').order('kickoff', { ascending: true }),
        ])
        if (rankingResult.error) throw rankingResult.error
        if (assignmentResult.error) throw assignmentResult.error

        const rankings = (rankingResult.data ?? []) as Ranking[]
        const assignments = (assignmentResult.data ?? []) as AssignmentRow[]
        const assignmentMap = new Map<string, Assignment[]>()
        for (const assignment of assignments) {
          const list = assignmentMap.get(assignment.referee_id) ?? []
          list.push({
            fixtureId: assignment.fixture_id,
            kickoff: assignment.kickoff,
            homeTeam: assignment.home_team,
            awayTeam: assignment.away_team,
            league: assignment.league,
          })
          assignmentMap.set(assignment.referee_id, list)
        }

        const usable = rankings.filter((r) => Number(r.matches_sample) >= 3 && r.yellow_cards_per_match != null)
        const medianY = median(usable.map((r) => Number(r.yellow_cards_per_match)))
        const medianR = median(usable.map((r) => Number(r.red_cards_per_match ?? 0)))
        const adjusted = usable.map((ranking) => ({
          ranking,
          yAdj: shrink(Number(ranking.yellow_cards_per_match), Number(ranking.matches_sample), medianY),
          rAdj: shrink(Number(ranking.red_cards_per_match ?? medianR), Number(ranking.matches_sample), medianR),
        }))
        const yValues = adjusted.map((x) => x.yAdj)
        const rValues = adjusted.map((x) => x.rAdj)

        const nextRows: RefWatchRow[] = adjusted.map(({ ranking, yAdj, rAdj }) => {
          const yellowIndex = Math.round(percentile(yAdj, yValues) * 100)
          const redIndex = Math.round(percentile(rAdj, rValues) * 100)
          return {
            id: ranking.referee_id,
            name: ranking.name,
            sourceKey: ranking.source_key,
            sample: Number(ranking.matches_sample),
            yellows: Number(ranking.yellow_cards_per_match),
            reds: Number(ranking.red_cards_per_match ?? 0),
            fouls: ranking.fouls_per_match == null ? null : Number(ranking.fouls_per_match),
            penalties: ranking.penalties_per_match == null ? null : Number(ranking.penalties_per_match),
            homeYellows: ranking.home_yellows_per_match == null ? null : Number(ranking.home_yellows_per_match),
            awayYellows: ranking.away_yellows_per_match == null ? null : Number(ranking.away_yellows_per_match),
            source: ranking.profile_source,
            asOfDate: ranking.as_of_date,
            yellowIndex,
            redIndex,
            aggression: Math.round(yellowIndex * 0.75 + redIndex * 0.25),
            reliability: Math.min(100, Math.round((Number(ranking.matches_sample) / (Number(ranking.matches_sample) + 12)) * 100)),
            recentMatches: Number(ranking.recent_matches ?? 0),
            recentYellows: ranking.recent_yellows_per_match == null ? null : Number(ranking.recent_yellows_per_match),
            recentReds: ranking.recent_reds_per_match == null ? null : Number(ranking.recent_reds_per_match),
            recentFouls: ranking.recent_fouls_per_match == null ? null : Number(ranking.recent_fouls_per_match),
            trend: trendFor(ranking),
            assignments: assignmentMap.get(ranking.referee_id) ?? [],
          }
        }).sort((a, b) => b.aggression - a.aggression || b.sample - a.sample)

        if (!cancelled) {
          setRows(nextRows)
          setSelectedId((current) => current && nextRows.some((r) => r.id === current) ? current : (nextRows[0]?.id ?? null))
          setMessage(`${nextRows.length} exact-ID referees ranked · ${assignments.length} confirmed future assignments · 7-day window`)
        }
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? `Ref Watch data error: ${error.message}` : 'Ref Watch data error')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [supabase, refreshKey])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = rows.filter((row) => {
      if (q && !row.name.toLowerCase().includes(q) && !row.assignments.some((a) => `${a.homeTeam} ${a.awayTeam} ${a.league}`.toLowerCase().includes(q))) return false
      if (filter === 'upcoming') return row.assignments.length > 0
      if (filter === 'yellow') return row.yellowIndex >= 75
      if (filter === 'red') return row.redIndex >= 75
      return true
    })
    return [...filtered].sort((a, b) => {
      if (sort === 'yellow') return b.yellows - a.yellows || b.sample - a.sample
      if (sort === 'red') return b.reds - a.reds || b.sample - a.sample
      if (sort === 'sample') return b.sample - a.sample || b.aggression - a.aggression
      if (sort === 'recent') return Number(b.recentYellows ?? -1) - Number(a.recentYellows ?? -1) || b.sample - a.sample
      return b.aggression - a.aggression || b.sample - a.sample
    })
  }, [rows, filter, sort, query])

  const selected = rows.find((row) => row.id === selectedId) ?? null
  const upcoming = rows.flatMap((row) => row.assignments.map((assignment) => ({ row, assignment })))
    .filter(({ row }) => row.aggression >= 65)
    .sort((a, b) => b.row.aggression - a.row.aggression || new Date(a.assignment.kickoff).getTime() - new Date(b.assignment.kickoff).getTime())
    .slice(0, 8)
  const top = rows[0]
  const redRiskCount = rows.filter((r) => r.redIndex >= 75).length
  const go = (page: string) => { window.location.hash = `/${page}` }

  return <div className="app-shell refwatch-page">
    <header className="topbar">
      <div className="brand-row">
        <div className="brand-mark"><Activity size={22} /></div>
        <div><div className="eyebrow">EVE ANALYTICS</div><h1>Football Scanner</h1></div>
      </div>
      <div className="header-right">
        <nav className="page-nav">
          <button onClick={() => go('best')}><Trophy size={15}/>Best Bets</button>
          <button onClick={() => go('markets')}><BarChart3 size={15}/>Market Lab</button>
          <button onClick={() => go('setup')}><Users size={15}/>Match Setup</button>
          <button className="active" onClick={() => go('refwatch')}><Flame size={15}/>Ref Watch</button>
          <button onClick={() => go('combos')}><Layers3 size={15}/>Combo Lab</button>
        </nav>
        <div className={`mode-pill ${supabase ? 'live' : 'error'}`}><span className="pulse-dot" />{supabase ? 'LIVE DATA' : 'NOT CONNECTED'}</div>
      </div>
    </header>

    <main>
      <section className="refwatch-hero">
        <div>
          <div className="eyebrow">EVE REFEREE INTELLIGENCE</div>
          <h2>Ref Watch <span>🔥</span></h2>
          <p>Find the referees most likely to drive card-heavy matches. EVE ranks yellow and red aggression with sample-size protection, uses actual recent refereed matches for trend, and links only explicitly confirmed future appointments.</p>
        </div>
        <button className="refwatch-refresh" onClick={() => setRefreshKey((x) => x + 1)} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''}/>{loading ? 'Refreshing…' : 'Refresh intelligence'}</button>
      </section>

      <section className="refwatch-status"><Flame size={18}/><strong>REF WATCH LIVE</strong><span>{message}</span></section>

      <section className="refwatch-kpis">
        <div><span>REFEREES RANKED</span><strong>{rows.length || '—'}</strong><small>Exact FotMob identities only</small></div>
        <div><span>MOST AGGRESSIVE</span><strong className="name-value">{top?.name ?? '—'}</strong><small>{top ? `${top.aggression}/100 aggression` : 'Waiting for data'}</small></div>
        <div><span>UPCOMING WATCH</span><strong>{rows.filter((r) => r.assignments.length).length || '—'}</strong><small>Confirmed refs next 7 days</small></div>
        <div><span>RED-RISK REFS</span><strong>{redRiskCount || '—'}</strong><small>Top quartile red tendency</small></div>
      </section>

      <section className="danger-section">
        <div className="refwatch-section-head">
          <div><div className="eyebrow">UPCOMING DANGER GAMES</div><h3>High-card referees on duty</h3></div>
          <span className="live-chip"><span/>NEXT 7 DAYS</span>
        </div>
        {upcoming.length ? <div className="danger-grid">{upcoming.map(({ row, assignment }) => {
          const sev = severity(row.aggression)
          return <button key={`${row.id}-${assignment.fixtureId}`} className="danger-card" onClick={() => setSelectedId(row.id)}>
            <div className="danger-top"><span className={`severity ${sev.className}`}>{sev.label}</span><strong>{row.aggression}</strong></div>
            <div className="danger-ref"><Flame size={16}/>{row.name}</div>
            <div className="danger-match">{assignment.homeTeam} <b>v</b> {assignment.awayTeam}</div>
            <div className="danger-meta"><span>{assignment.league}</span><span>{formatDate(assignment.kickoff)}</span></div>
            <div className="danger-stats"><span><b>{row.yellows.toFixed(2)}</b> yellows</span><span><b>{row.reds.toFixed(3)}</b> reds</span><span><b>{row.sample}</b> matches</span></div>
          </button>
        })}</div> : <div className="refwatch-empty"><CalendarDays size={22}/><strong>No high-aggression referee is currently assigned inside the next seven days.</strong><span>EVE will surface the match automatically when a confirmed appointment appears.</span></div>}
      </section>

      {selected && <section className="ref-detail">
        <div className="ref-detail-title">
          <div><span className={`severity ${severity(selected.aggression).className}`}>{severity(selected.aggression).label}</span><h3>{selected.name}</h3><p>{selected.sourceKey} · {selected.sample} profile matches · source {selected.source}</p></div>
          <div className="score-orb"><strong>{selected.aggression}</strong><span>AGGRESSION</span></div>
        </div>
        <div className="ref-detail-stats">
          <div><span>Yellow cards</span><strong>{selected.yellows.toFixed(2)}</strong><small>per match · index {selected.yellowIndex}/100</small></div>
          <div><span>Red cards</span><strong>{selected.reds.toFixed(3)}</strong><small>per match · {redRisk(selected.reds)} risk</small></div>
          <div><span>Fouls</span><strong>{selected.fouls == null ? '—' : selected.fouls.toFixed(2)}</strong><small>per match</small></div>
          <div><span>Recent yellows</span><strong>{selected.recentYellows == null ? '—' : selected.recentYellows.toFixed(2)}</strong><small>{selected.recentMatches ? `latest ${selected.recentMatches} tracked` : 'awaiting recent sample'}</small></div>
          <div><span>Sample confidence</span><strong>{selected.reliability}%</strong><small>{selected.sample} recorded matches</small></div>
          <div><span>Recent trend</span><strong className={`trend ${selected.trend.toLowerCase()}`}>{selected.trend}</strong><small>Actual recent matches vs profile</small></div>
        </div>
        <div className="ref-model-note"><ShieldAlert size={17}/><span><strong>How EVE ranks this:</strong> 75% yellow-card aggression + 25% red-card aggression, with both rates shrunk toward the database median when the sample is small. Referee assignments shown here must be explicitly confirmed and tied to an exact FotMob identity.</span></div>
        {selected.assignments.length > 0 && <div className="selected-assignments"><strong>Confirmed upcoming assignment{selected.assignments.length > 1 ? 's' : ''}</strong>{selected.assignments.map((a) => <div key={a.fixtureId}><span>{a.homeTeam} v {a.awayTeam}</span><span>{a.league}</span><b>{formatDate(a.kickoff)}</b></div>)}</div>}
      </section>}

      <section className="ref-ranking-section">
        <div className="refwatch-section-head ranking-head">
          <div><div className="eyebrow">AGGRESSION RANKING</div><h3>Most aggressive referees</h3></div>
          <div className="ref-tools">
            <label className="ref-search"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search referee or match"/></label>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}><option value="aggression">Sort: Aggression</option><option value="yellow">Sort: Yellows</option><option value="red">Sort: Reds</option><option value="recent">Sort: Recent yellows</option><option value="sample">Sort: Sample</option></select>
          </div>
        </div>
        <div className="ref-filter-tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All refs</button>
          <button className={filter === 'upcoming' ? 'active' : ''} onClick={() => setFilter('upcoming')}>Upcoming duty</button>
          <button className={filter === 'yellow' ? 'active' : ''} onClick={() => setFilter('yellow')}>Yellow hawks</button>
          <button className={filter === 'red' ? 'active' : ''} onClick={() => setFilter('red')}>Red risk</button>
        </div>

        <div className="ref-table-head"><span>Rank / Referee</span><span>Aggression</span><span>Yellows</span><span>Reds</span><span>Sample</span><span>Next duty</span><span/></div>
        <div className="ref-list">{visible.map((row, index) => {
          const sev = severity(row.aggression)
          const next = row.assignments[0]
          return <button key={row.id} className={`ref-row ${selectedId === row.id ? 'selected' : ''}`} onClick={() => setSelectedId(row.id)}>
            <span className="ref-name-cell"><b>#{index + 1}</b><i className={`rank-flame ${sev.className}`}><Flame size={16}/></i><span><strong>{row.name}</strong><small className={`severity ${sev.className}`}>{sev.label}</small></span></span>
            <span className="aggression-cell"><strong>{row.aggression}</strong><i><em style={{ width: `${row.aggression}%` }}/></i></span>
            <span><strong>{row.yellows.toFixed(2)}</strong><small>per game</small></span>
            <span><strong>{row.reds.toFixed(3)}</strong><small>{redRisk(row.reds)}</small></span>
            <span><strong>{row.sample}</strong><small>{row.reliability}% reliable</small></span>
            <span className="next-duty">{next ? <><strong>{next.homeTeam} v {next.awayTeam}</strong><small>{formatDate(next.kickoff)}</small></> : <><strong>Not assigned</strong><small>inside 7-day watch</small></>}</span>
            <span><ChevronRight size={17}/></span>
          </button>
        })}</div>
        {!loading && visible.length === 0 && <div className="refwatch-empty"><AlertTriangle size={21}/><strong>No referee matches this filter.</strong></div>}
      </section>
    </main>

    <footer>EVE Ref Watch · Exact FotMob IDs · Confirmed assignments only · Sample-size protected · Recent-match trend</footer>
  </div>
}
