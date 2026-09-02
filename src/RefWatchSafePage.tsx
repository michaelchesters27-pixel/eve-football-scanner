import { useEffect, useMemo, useState } from 'react'
import { Activity, BarChart3, Flame, Layers3, RefreshCw, Search, Trophy, Users } from 'lucide-react'
import { createClient } from '@supabase/supabase-js'

type Ranking={
  referee_id:string;name:string;source_key:string;as_of_date:string;matches_sample:number;
  yellow_cards_per_match:number;red_cards_per_match:number|null;fouls_per_match:number|null;penalties_per_match:number|null;
  home_yellows_per_match:number|null;away_yellows_per_match:number|null;profile_source:string;
  recent_matches:number|null;recent_yellows_per_match:number|null;recent_reds_per_match:number|null;
  recent_fouls_per_match:number|null;recent_home_yellows_per_match:number|null;recent_away_yellows_per_match:number|null;
  latest_match_at:string|null;upcoming_assignments:number;
}
type Assignment={fixture_id:string;kickoff:string;referee_id:string;referee_name:string;referee_source_key:string;league:string;home_team:string;away_team:string}
type Row=Ranking&{yellowIndex:number;redIndex:number;aggression:number;reliability:number;trend:'RISING'|'STEADY'|'COOLING'|'NO RECENT SAMPLE';assignments:Assignment[]}

type Sort='aggression'|'yellow'|'red'|'sample'|'recent'
const LONDON='Europe/London'

function median(values:number[]){if(!values.length)return 0;const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2}
function shrink(value:number,sample:number,baseline:number){const w=sample/(sample+12);return value*w+baseline*(1-w)}
function percentile(value:number,values:number[]){if(values.length<=1)return 1;const s=[...values].sort((a,b)=>a-b),below=s.filter(v=>v<value).length,equal=s.filter(v=>v===value).length;return Math.max(0,Math.min(1,(below+Math.max(0,equal-1)/2)/(s.length-1)))}
function fmt(n:number|null|undefined,d=2){return n==null?'—':Number(n).toFixed(d)}
function formatDate(value:string){const d=new Date(value);return `${d.toLocaleDateString('en-GB',{timeZone:LONDON,weekday:'short',day:'2-digit',month:'short'}).toUpperCase()} · ${d.toLocaleTimeString('en-GB',{timeZone:LONDON,hour:'2-digit',minute:'2-digit',hour12:false})}`}
function trend(row:Ranking):Row['trend']{
  if(!row.recent_matches||row.recent_matches<3||row.recent_yellows_per_match==null)return 'NO RECENT SAMPLE'
  const delta=Number(row.recent_yellows_per_match)-Number(row.yellow_cards_per_match)+(Number(row.recent_reds_per_match??0)-Number(row.red_cards_per_match??0))*4
  if(delta>=.25)return 'RISING'
  if(delta<=-.25)return 'COOLING'
  return 'STEADY'
}
function severity(score:number){if(score>=90)return 'EXTREME REF';if(score>=80)return 'VERY HIGH';if(score>=65)return 'HIGH CARD REF';if(score>=50)return 'ABOVE AVERAGE';return 'STANDARD'}

export default function RefWatchSafePage(){
  const url=import.meta.env.VITE_SUPABASE_URL as string|undefined
  const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string|undefined
  const supabase=useMemo(()=>url&&key?createClient(url,key):null,[url,key])
  const [rows,setRows]=useState<Row[]>([]),[loading,setLoading]=useState(true),[message,setMessage]=useState('Loading referee intelligence…')
  const [query,setQuery]=useState(''),[sort,setSort]=useState<Sort>('aggression'),[selectedId,setSelectedId]=useState<string|null>(null),[refresh,setRefresh]=useState(0)

  useEffect(()=>{
    if(!supabase){setLoading(false);setMessage('Supabase is not connected');return}
    let cancelled=false
    ;(async()=>{
      setLoading(true);setMessage('Reading exact referee identities, confirmed assignments and recent form…')
      try{
        const [rankResult,assignmentResult]=await Promise.all([
          supabase.from('ref_watch_rankings').select('*'),
          supabase.from('ref_watch_assignments').select('*').order('kickoff',{ascending:true}),
        ])
        if(rankResult.error)throw rankResult.error
        if(assignmentResult.error)throw assignmentResult.error
        const rankings=(rankResult.data??[]) as Ranking[],assignments=(assignmentResult.data??[]) as Assignment[]
        const assignmentMap=new Map<string,Assignment[]>()
        for(const a of assignments){const list=assignmentMap.get(a.referee_id)??[];list.push(a);assignmentMap.set(a.referee_id,list)}
        const medianY=median(rankings.map(r=>Number(r.yellow_cards_per_match))),medianR=median(rankings.map(r=>Number(r.red_cards_per_match??0)))
        const adjusted=rankings.map(r=>({r,y:shrink(Number(r.yellow_cards_per_match),Number(r.matches_sample),medianY),red:shrink(Number(r.red_cards_per_match??medianR),Number(r.matches_sample),medianR)}))
        const ys=adjusted.map(x=>x.y),reds=adjusted.map(x=>x.red)
        const next=adjusted.map(({r,y,red})=>{
          const yellowIndex=Math.round(percentile(y,ys)*100),redIndex=Math.round(percentile(red,reds)*100)
          return {...r,yellowIndex,redIndex,aggression:Math.round(yellowIndex*.75+redIndex*.25),reliability:Math.min(100,Math.round(Number(r.matches_sample)/(Number(r.matches_sample)+12)*100)),trend:trend(r),assignments:assignmentMap.get(r.referee_id)??[]}
        }).sort((a,b)=>b.aggression-a.aggression||b.matches_sample-a.matches_sample)
        if(!cancelled){setRows(next);setSelectedId(id=>id&&next.some(r=>r.referee_id===id)?id:(next[0]?.referee_id??null));setMessage(`${next.length} exact-ID referees ranked · ${assignments.length} confirmed future assignments · 7-day assignment window`)}
      }catch(error){if(!cancelled)setMessage(error instanceof Error?`Ref Watch data error: ${error.message}`:'Ref Watch data error')}
      finally{if(!cancelled)setLoading(false)}
    })()
    return()=>{cancelled=true}
  },[supabase,refresh])

  const visible=useMemo(()=>rows.filter(r=>{const q=query.trim().toLowerCase();return !q||r.name.toLowerCase().includes(q)||r.assignments.some(a=>`${a.home_team} ${a.away_team} ${a.league}`.toLowerCase().includes(q))}).sort((a,b)=>{
    if(sort==='yellow')return b.yellow_cards_per_match-a.yellow_cards_per_match||b.matches_sample-a.matches_sample
    if(sort==='red')return Number(b.red_cards_per_match??0)-Number(a.red_cards_per_match??0)||b.matches_sample-a.matches_sample
    if(sort==='sample')return b.matches_sample-a.matches_sample
    if(sort==='recent')return Number(b.recent_yellows_per_match??-1)-Number(a.recent_yellows_per_match??-1)
    return b.aggression-a.aggression||b.matches_sample-a.matches_sample
  }),[rows,query,sort])
  const selected=rows.find(r=>r.referee_id===selectedId)??null
  const go=(page:string)=>{window.location.hash=`/${page}`}

  return <div className="app-shell refwatch-page">
    <header className="topbar"><div className="brand-row"><div className="brand-mark"><Activity size={22}/></div><div><div className="eyebrow">EVE ANALYTICS</div><h1>Football Scanner</h1></div></div><div className="header-right"><nav className="page-nav"><button onClick={()=>go('best')}><Trophy size={15}/>Best Bets</button><button onClick={()=>go('markets')}><BarChart3 size={15}/>Market Lab</button><button onClick={()=>go('setup')}><Users size={15}/>Match Setup</button><button className="active" onClick={()=>go('refwatch')}><Flame size={15}/>Ref Watch</button><button onClick={()=>go('combos')}><Layers3 size={15}/>Combo Lab</button></nav><div className={`mode-pill ${supabase?'live':'error'}`}><span className="pulse-dot"/>{supabase?'LIVE DATA':'NOT CONNECTED'}</div></div></header>

    <main className="content refwatch-content">
      <section className="hero-card refwatch-hero"><div><div className="eyebrow">REFEREE INTELLIGENCE</div><h2>Ref Watch</h2><p>Exact FotMob identities only. Rankings are sample-shrunk; recent form uses the latest actual refereed matches; assignments appear only when EVE has an explicit confirmed referee.</p></div><button className="refresh-button" onClick={()=>setRefresh(v=>v+1)} disabled={loading}><RefreshCw size={16} className={loading?'spin':''}/>Refresh</button></section>
      <div className="status-line">{message}</div>

      <section className="refwatch-controls"><div className="search-box"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search referee, team or league"/></div><select value={sort} onChange={e=>setSort(e.target.value as Sort)}><option value="aggression">Aggression score</option><option value="yellow">Yellow rate</option><option value="red">Red rate</option><option value="recent">Recent yellow rate</option><option value="sample">Sample size</option></select></section>

      <section className="refwatch-grid">
        <div className="refwatch-list">{visible.map(row=><button key={row.referee_id} className={`refwatch-row ${selectedId===row.referee_id?'selected':''}`} onClick={()=>setSelectedId(row.referee_id)}><div><strong>{row.name}</strong><span>{row.matches_sample} profile matches · {row.recent_matches??0} recent tracked · {row.assignments.length} upcoming</span></div><div className="refwatch-row-stats"><span>{fmt(row.yellow_cards_per_match)} YC</span><span>{fmt(row.red_cards_per_match,3)} RC</span><b>{row.aggression}</b></div></button>)}</div>

        <aside className="refwatch-detail">{selected?<><div className="eyebrow">{severity(selected.aggression)}</div><h3>{selected.name}</h3><p className="muted">{selected.source_key} · profile {selected.profile_source}</p><div className="metric-grid"><div><span>Yellow cards</span><strong>{fmt(selected.yellow_cards_per_match)}</strong></div><div><span>Red cards</span><strong>{fmt(selected.red_cards_per_match,3)}</strong></div><div><span>Aggression</span><strong>{selected.aggression}/100</strong></div><div><span>Reliability</span><strong>{selected.reliability}%</strong></div><div><span>Recent yellows</span><strong>{fmt(selected.recent_yellows_per_match)}</strong></div><div><span>Recent reds</span><strong>{fmt(selected.recent_reds_per_match,3)}</strong></div><div><span>Recent form</span><strong>{selected.trend}</strong></div><div><span>Recent sample</span><strong>{selected.recent_matches??0}</strong></div></div><h4>Confirmed upcoming assignments</h4>{selected.assignments.length?<div className="assignment-list">{selected.assignments.map(a=><div key={a.fixture_id} className="assignment-card"><strong>{a.home_team} v {a.away_team}</strong><span>{a.league}</span><span>{formatDate(a.kickoff)}</span></div>)}</div>:<p className="muted">No confirmed future assignment in the next 7 days.</p>}</>:<p>Select a referee.</p>}</aside>
      </section>
    </main>
  </div>
}
