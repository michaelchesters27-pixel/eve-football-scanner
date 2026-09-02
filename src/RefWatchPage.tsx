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

type RefProfile = {
  referee_id: string
  as_of_date: string
  matches_sample: number
  yellow_cards_per_match: number | null
  red_cards_per_match: number | null
  fouls_per_match: number | null
  penalties_per_match: number | null
  home_yellows_per_match: number | null
  away_yellows_per_match: number | null
  source: string
}

type Referee = { id: string; name: string }
type Fixture = {
  id: string
  kickoff: string
  referee_id: string | null
  league_id: string
  home_team_id: string
  away_team_id: string
  status: string
}
type Team = { id: string; name: string }
type League = { id: string; name: string }

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
  trend: 'RISING' | 'STEADY' | 'COOLING' | 'NEW'
  assignments: Assignment[]
}

type Filter = 'all' | 'upcoming' | 'yellow' | 'red'
type Sort = 'aggression' | 'yellow' | 'red' | 'sample'

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
  const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(date) === new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(today)
  const tomorrow = new Date(today.getTime() + 86400000)
  const isTomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(date) === new Intl.DateTimeFormat('en-CA', { timeZone: LONDON }).format(tomorrow)
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

function trendFor(history: RefProfile[], latest: RefProfile): RefWatchRow['trend'] {
  const previous = history.find((row) => row.as_of_date < latest.as_of_date && row.yellow_cards_per_match != null)
  if (!previous || previous.yellow_cards_per_match == null || latest.yellow_cards_per_match == null) return 'NEW'
  const yellowDelta = Number(latest.yellow_cards_per_match) - Number(previous.yellow_cards_per_match)
  const redDelta = Number(latest.red_cards_per_match ?? 0) - Number(previous.red_cards_per_match ?? 0)
  const combined = yellowDelta + redDelta * 4
  if (combined >= 0.2) return 'RISING'
  if (combined <= -0.2) return 'COOLING'
  return 'STEADY'
}

export default function RefWatchPage() {
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
      setMessage('Reading referee profiles and upcoming appointments…')
      try {
        const now = new Date()
        const from = new Date(now.getTime() - 3 * 3600000).toISOString()
        const to = new Date(now.getTime() + 4 * 24 * 3600000).toISOString()
        const [profileResult, refereeResult, fixtureResult] = await Promise.all([
          supabase.from('referee_profiles').select('referee_id,as_of_date,matches_sample,yellow_cards_per_match,red_cards_per_match,fouls_per_match,penalties_per_match,home_yellows_per_match,away_yellows_per_match,source').order('as_of_date', { ascending: false }).order('matches_sample', { ascending: false }).limit(1200),
          supabase.from('referees').select('id,name').limit(1200),
          supabase.from('fixtures').select('id,kickoff,referee_id,league_id,home_team_id,away_team_id,status').in('status', ['scheduled', 'live']).gte('kickoff', from).lte('kickoff', to).not('referee_id', 'is', null).order('kickoff', { ascending: true }).limit(300),
        ])

        if (profileResult.error) throw profileResult.error
        if (refereeResult.error) throw refereeResult.error
        if (fixtureResult.error) throw fixtureResult.error

        const profiles = (profileResult.data ?? []) as RefProfile[]
        const referees = (refereeResult.data ?? []) as Referee[]
        const fixtures = (fixtureResult.data ?? []) as Fixture[]

        const teamIds = [...new Set(fixtures.flatMap((f) => [f.home_team_id, f.away_team_id]))]
        const leagueIds = [...new Set(fixtures.map((f) => f.league_id))]
        const [teamResult, leagueResult] = await Promise.all([
          teamIds.length ? supabase.from('teams').select('id,name').in('id', teamIds) : Promise.resolve({ data: [], error: null }),
          leagueIds.length ? supabase.from('leagues').select('id,name').in('id', leagueIds) : Promise.resolve({ data: [], error: null }),
        ])
        if (teamResult.error) throw teamResult.error
        if (leagueResult.error) throw leagueResult.error

        const teams = new Map(((teamResult.data ?? []) as Team[]).map((t) => [t.id, t.name]))
        const leagues = new Map(((leagueResult.data ?? []) as League[]).map((l) => [l.id, l.name]))
        const names = new Map(referees.map((r) => [r.id, r.name]))
        const history = new Map<string, RefProfile[]>()
        profiles.forEach((profile) => {
          const list = history.get(profile.referee_id) ?? []
          list.push(profile)
          history.set(profile.referee_id, list)
        })

        const latestProfiles: RefProfile[] = []
        history.forEach((items) => {
          const usable = items.find((p) => Number(p.matches_sample) >= 3 && p.yellow_cards_per_match != null)
          if (usable) latestProfiles.push(usable)
        })

        const medianY = median(latestProfiles.map((p) => Number(p.yellow_cards_per_match ?? 0)))
        const medianR = median(latestProfiles.map((p) => Number(p.red_cards_per_match ?? 0)))
        const base = latestProfiles.map((profile) => ({
          profile,
          yAdj: shrink(Number(profile.yellow_cards_per_match ?? medianY), Number(profile.matches_sample), medianY),
          rAdj: shrink(Number(profile.red_cards_per_match ?? medianR), Number(profile.matches_sample), medianR),
        }))
        const yValues = base.map((x) => x.yAdj)
        const rValues = base.map((x) => x.rAdj)

        const assignmentMap = new Map<string, Assignment[]>()
        fixtures.forEach((fixture) => {
          if (!fixture.referee_id) return
          const list = assignmentMap.get(fixture.referee_id) ?? []
          list.push({
            fixtureId: fixture.id,
            kickoff: fixture.kickoff,
            homeTeam: teams.get(fixture.home_team_id) ?? 'Home team',
            awayTeam: teams.get(fixture.away_team_id) ?? 'Away team',
            league: leagues.get(fixture.league_id) ?? 'Competition',
          })
          assignmentMap.set(fixture.referee_id, list)
        })

        const nextRows: RefWatchRow[] = base.map(({ profile, yAdj, rAdj }) => {
          const yellowIndex = Math.round(percentile(yAdj, yValues) * 100)
          const redIndex = Math.round(percentile(rAdj, rValues) * 100)
          return {
            id: profile.referee_id,
            name: names.get(profile.referee_id) ?? 'Unknown referee',
            sample: Number(profile.matches_sample),
            yellows: Number(profile.yellow_cards_per_match ?? 0),
            reds: Number(profile.red_cards_per_match ?? 0),
            fouls: profile.fouls_per_match == null ? null : Number(profile.fouls_per_match),
            penalties: profile.penalties_per_match == null ? null : Number(profile.penalties_per_match),
            homeYellows: profile.home_yellows_per_match == null ? null : Number(profile.home_yellows_per_match),
            awayYellows: profile.away_yellows_per_match == null ? null : Number(profile.away_yellows_per_match),
            source: profile.source,
            asOfDate: profile.as_of_date,
            yellowIndex,
            redIndex,
            aggression: Math.round(yellowIndex * 0.75 + redIndex * 0.25),
            reliability: Math.min(100, Math.round((Number(profile.matches_sample) / (Number(profile.matches_sample) + 12)) * 100)),
            trend: trendFor(history.get(profile.referee_id) ?? [], profile),
            assignments: assignmentMap.get(profile.referee_id) ?? [],
          }
        }).filter((row) => row.name !== 'Unknown referee')

        nextRows.sort((a, b) => b.aggression - a.aggression || b.sample - a.sample)
        if (!cancelled) {
          setRows(nextRows)
          setSelectedId((current) => current && nextRows.some((r) => r.id === current) ? current : (nextRows[0]?.id ?? null))
          setMessage(`${nextRows.length} referees ranked · ${fixtures.length} confirmed upcoming assignments in the next 4 days`)
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
          <p>Find the referees most likely to drive card-heavy matches. EVE ranks yellow and red aggression with sample-size protection, then connects the dangerous referees to their next assignments.</p>
        </div>
        <button className="refwatch-refresh" onClick={() => setRefreshKey((x) => x + 1)} disabled={loading}><RefreshCw size={17} className={loading ? 'spin' : ''}/>{loading ? 'Refreshing…' : 'Refresh intelligence'}</button>
      </section>

      <section className="refwatch-status"><Flame size={18}/><strong>REF WATCH LIVE</strong><span>{message}</span></section>

      <section className="refwatch-kpis">
        <div><span>REFEREES RANKED</span><strong>{rows.length || '—'}</strong><small>Usable historical profiles</small></div>
        <div><span>MOST AGGRESSIVE</span><strong className="name-value">{top?.name ?? '—'}</strong><small>{top ? `${top.aggression}/100 aggression` : 'Waiting for data'}</small></div>
        <div><span>UPCOMING WATCH</span><strong>{rows.filter((r) => r.assignments.length).length || '—'}</strong><small>Refs assigned next 4 days</small></div>
        <div><span>RED-RISK REFS</span><strong>{redRiskCount || '—'}</strong><small>Top quartile red tendency</small></div>
      </section>

      <section className="danger-section">
        <div className="refwatch-section-head">
          <div><div className="eyebrow">UPCOMING DANGER GAMES</div><h3>High-card referees on duty</h3></div>
          <span className="live-chip"><span/>NEXT 4 DAYS</span>
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
        })}</div> : <div className="refwatch-empty"><CalendarDays size={22}/><strong>No high-aggression referee is currently assigned inside the next four days.</strong><span>EVE will surface the match automatically as soon as an appointment appears.</span></div>}
      </section>

      {selected && <section className="ref-detail">
        <div className="ref-detail-title">
          <div><span className={`severity ${severity(selected.aggression).className}`}>{severity(selected.aggression).label}</span><h3>{selected.name}</h3><p>Historical referee profile · {selected.sample} matches · source {selected.source}</p></div>
          <div className="score-orb"><strong>{selected.aggression}</strong><span>AGGRESSION</span></div>
        </div>
        <div className="ref-detail-stats">
          <div><span>Yellow cards</span><strong>{selected.yellows.toFixed(2)}</strong><small>per match · index {selected.yellowIndex}/100</small></div>
          <div><span>Red cards</span><strong>{selected.reds.toFixed(3)}</strong><small>per match · {redRisk(selected.reds)} risk</small></div>
          <div><span>Fouls</span><strong>{selected.fouls == null ? '—' : selected.fouls.toFixed(2)}</strong><small>per match</small></div>
          <div><span>Penalties</span><strong>{selected.penalties == null ? '—' : selected.penalties.toFixed(3)}</strong><small>per match · display only</small></div>
          <div><span>Sample confidence</span><strong>{selected.reliability}%</strong><small>{selected.sample} recorded matches</small></div>
          <div><span>Profile trend</span><strong className={`trend ${selected.trend.toLowerCase()}`}>{selected.trend}</strong><small>Latest profile vs prior snapshot</small></div>
        </div>
        <div className="ref-model-note"><ShieldAlert size={17}/><span><strong>How EVE ranks this:</strong> 75% yellow-card aggression + 25% red-card aggression, with both rates shrunk toward the database median when the sample is small. This stops tiny samples from dominating Ref Watch.</span></div>
        {selected.assignments.length > 0 && <div className="selected-assignments"><strong>Upcoming assignment{selected.assignments.length > 1 ? 's' : ''}</strong>{selected.assignments.map((a) => <div key={a.fixtureId}><span>{a.homeTeam} v {a.awayTeam}</span><span>{a.league}</span><b>{formatDate(a.kickoff)}</b></div>)}</div>}
      </section>}

      <section className="ref-ranking-section">
        <div className="refwatch-section-head ranking-head">
          <div><div className="eyebrow">AGGRESSION RANKING</div><h3>Most aggressive referees</h3></div>
          <div className="ref-tools">
            <label className="ref-search"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search referee or match"/></label>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}><option value="aggression">Sort: Aggression</option><option value="yellow">Sort: Yellows</option><option value="red">Sort: Reds</option><option value="sample">Sort: Sample</option></select>
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
            <span className="next-duty">{next ? <><strong>{next.homeTeam} v {next.awayTeam}</strong><small>{formatDate(next.kickoff)}</small></> : <><strong>Not assigned</strong><small>inside 4-day watch</small></>}</span>
            <span><ChevronRight size={17}/></span>
          </button>
        })}</div>
        {!loading && visible.length === 0 && <div className="refwatch-empty"><AlertTriangle size={21}/><strong>No referee matches this filter.</strong></div>}
      </section>
    </main>

    <footer>EVE Ref Watch · Yellow + red aggression · Sample-size protected · Upcoming assignments linked automatically</footer>
  </div>
}
