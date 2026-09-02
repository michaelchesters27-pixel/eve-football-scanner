import { createClient } from '@supabase/supabase-js'
import { buildRefereeIntelligence, type RefereeProfile } from './_shared/referee-intelligence'

type MatchRow={
  fixture_id:string
  kickoff:string
  referee_id:string|null
  team_id:string
  opponent_team_id:string
  venue:'home'|'away'
  yellow_cards:number|null
  red_cards:number|null
  fouls:number|null
  opponent_yellow_cards:number|null
}
type RefMatch={kickoff:number;homeYellows:number;awayYellows:number;reds:number|null;fouls:number|null}
type Evidence={key:string;score:number}
type Evaluated={side:'home'|'away';full:number;old:number;noRef:number;dataQuality:number;win:boolean;refSample:number;refScore:number}

const JOB='backtest-referee-v2-2526'
const HISTORY_START='2024-07-01T00:00:00.000Z'
const TARGET_START='2025-07-01T00:00:00.000Z'
const TARGET_END='2026-07-01T00:00:00.000Z'
const WEIGHTS={recent:.24,venue:.20,opponent:.17,referee:.18,season:.11,h2h:.10}

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function clamp(value:number,min=0,max=100){return Math.max(min,Math.min(max,value))}
function recent<T>(rows:T[],count:number){return rows.slice(Math.max(0,rows.length-count))}
function pct(rows:MatchRow[],test:(row:MatchRow)=>boolean){return rows.length?rows.filter(test).length/rows.length*100:0}
function avg(values:number[]){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0}
function sampleQuality(parts:Array<[number,number,number]>){const tw=parts.reduce((s,[,,w])=>s+w,0);return tw?Math.round(parts.reduce((s,[a,t,w])=>s+clamp(a/t,0,1)*w,0)/tw*100):0}
function score(evidence:Evidence[],dataQuality:number,omit:string[]=[]){
  let total=0,used=0
  for(const item of evidence){const w=(WEIGHTS as any)[item.key] as number|undefined;if(!w||omit.includes(item.key)) continue;total+=item.score*w;used+=w}
  const raw=used?total/used:0
  return Math.round(raw*(.88+clamp(dataQuality)/100*.12))
}
function wilsonLow(wins:number,n:number){if(!n)return 0;const z=1.96,p=wins/n,d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n);return(c-m)/d*100}
function round1(n:number){return Math.round(n*10)/10}
function stat(rows:Evaluated[],field:'full'|'old'|'noRef',threshold:number){const selected=rows.filter((r)=>r.dataQuality>=70&&r[field]>=threshold),wins=selected.filter((r)=>r.win).length;return{threshold,n:selected.length,wins,hitRate:selected.length?round1(wins/selected.length*100):0,wilsonLow:round1(wilsonLow(wins,selected.length))}}

async function fetchRows(supabase:ReturnType<typeof createClient>){
  const all:MatchRow[]=[]
  for(let from=0;;from+=1000){
    const {data,error}=await supabase.from('team_match_flat')
      .select('fixture_id,kickoff,referee_id,team_id,opponent_team_id,venue,yellow_cards,red_cards,fouls,opponent_yellow_cards')
      .gte('kickoff',HISTORY_START).lt('kickoff',TARGET_END)
      .order('kickoff',{ascending:true}).order('fixture_id',{ascending:true}).range(from,from+999)
    if(error) throw error
    const page=(data??[]) as MatchRow[];all.push(...page);if(page.length<1000)break
  }
  return all
}

function refProfile(history:RefMatch[],cutoff:number):RefereeProfile|null{
  const rows=history.filter((r)=>r.kickoff<cutoff&&r.kickoff>=cutoff-730*86400000)
  if(rows.length<3)return null
  const reds=rows.map((r)=>r.reds).filter((v):v is number=>v!=null&&Number.isFinite(v))
  const fouls=rows.map((r)=>r.fouls).filter((v):v is number=>v!=null&&Number.isFinite(v))
  return{
    matches_sample:rows.length,
    yellow_cards_per_match:avg(rows.map((r)=>r.homeYellows+r.awayYellows)),
    red_cards_per_match:reds.length?avg(reds):null,
    fouls_per_match:fouls.length?avg(fouls):null,
    penalties_per_match:null,
    home_yellows_per_match:avg(rows.map((r)=>r.homeYellows)),
    away_yellows_per_match:avg(rows.map((r)=>r.awayYellows)),
    source:'eve-derived',sources:['eve-derived'],
  }
}

function cardEvidence(side:'home'|'away',own:MatchRow[],opp:MatchRow[],opponentId:string,profile:RefereeProfile|null){
  const r10=recent(own,10),venue10=recent(own.filter((r)=>r.venue===side),10),opp10=recent(opp,10),season=recent(own,30),h2h=recent(own.filter((r)=>r.opponent_team_id===opponentId),5)
  const intel=buildRefereeIntelligence(profile,side)
  const oldYellow=Number(profile?.yellow_cards_per_match??0)
  const oldRef=profile?clamp(45+(oldYellow-3.5)*18):45
  const common:Evidence[]=[
    {key:'recent',score:Math.round(pct(r10,(r)=>(r.yellow_cards??-1)>=2))},
    {key:'venue',score:Math.round(pct(venue10,(r)=>(r.yellow_cards??-1)>=2))},
    {key:'opponent',score:Math.round(pct(opp10,(r)=>(r.opponent_yellow_cards??-1)>=2))},
    {key:'season',score:Math.round(pct(season,(r)=>(r.yellow_cards??-1)>=2))},
    {key:'h2h',score:h2h.length?Math.round(pct(h2h,(r)=>(r.yellow_cards??-1)>=2)):50},
  ]
  const full=[...common,{key:'referee',score:Math.round(intel.score)}]
  const old=[...common,{key:'referee',score:Math.round(oldRef)}]
  const dq=sampleQuality([[r10.length,10,24],[venue10.length,10,20],[opp10.length,10,17],[Number(profile?.matches_sample??0),10,18],[season.length,25,11],[h2h.length,4,10]])
  return{full,old,dq,intel}
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:run,error:runError}=await supabase.from('source_sync_runs').insert({source:'eve-backtest',job_name:JOB,status:'running'}).select('id').single()
  if(runError) throw runError
  try{
    const rows=await fetchRows(supabase)
    const fixtureMap=new Map<string,{kickoff:string;refereeId:string|null;home?:MatchRow;away?:MatchRow}>()
    for(const row of rows){const f=fixtureMap.get(row.fixture_id)??{kickoff:row.kickoff,refereeId:row.referee_id};if(row.venue==='home')f.home=row;else f.away=row;fixtureMap.set(row.fixture_id,f)}
    const fixtures=[...fixtureMap.values()].filter((f)=>f.home&&f.away).sort((a,b)=>Date.parse(a.kickoff)-Date.parse(b.kickoff)) as Array<{kickoff:string;refereeId:string|null;home:MatchRow;away:MatchRow}>
    const teamHistory=new Map<string,MatchRow[]>(),refHistory=new Map<string,RefMatch[]>(),evaluated:Evaluated[]=[]
    let targetFixtures=0,skippedLowHistory=0

    const append=(f:typeof fixtures[number])=>{
      for(const row of [f.home,f.away]){const arr=teamHistory.get(row.team_id)??[];arr.push(row);teamHistory.set(row.team_id,arr)}
      if(f.refereeId&&f.home.yellow_cards!=null&&f.away.yellow_cards!=null){
        const arr=refHistory.get(f.refereeId)??[]
        const reds=f.home.red_cards!=null&&f.away.red_cards!=null?f.home.red_cards+f.away.red_cards:null
        const fouls=f.home.fouls!=null&&f.away.fouls!=null?f.home.fouls+f.away.fouls:null
        arr.push({kickoff:Date.parse(f.kickoff),homeYellows:f.home.yellow_cards,awayYellows:f.away.yellow_cards,reds,fouls});refHistory.set(f.refereeId,arr)
      }
    }

    for(const f of fixtures){
      const t=Date.parse(f.kickoff)
      if(f.kickoff<TARGET_START){append(f);continue}
      if(f.kickoff>=TARGET_END)break
      targetFixtures+=1
      const homeHist=teamHistory.get(f.home.team_id)??[],awayHist=teamHistory.get(f.away.team_id)??[]
      if(homeHist.length<5||awayHist.length<5){skippedLowHistory+=1;append(f);continue}
      const profile=f.refereeId?refProfile(refHistory.get(f.refereeId)??[],t):null
      if(f.home.yellow_cards!=null){const x=cardEvidence('home',homeHist,awayHist,f.away.team_id,profile);evaluated.push({side:'home',full:score(x.full,x.dq),old:score(x.old,x.dq),noRef:score(x.full,x.dq,['referee']),dataQuality:x.dq,win:f.home.yellow_cards>=2,refSample:Number(profile?.matches_sample??0),refScore:x.intel.score})}
      if(f.away.yellow_cards!=null){const x=cardEvidence('away',awayHist,homeHist,f.home.team_id,profile);evaluated.push({side:'away',full:score(x.full,x.dq),old:score(x.old,x.dq),noRef:score(x.full,x.dq,['referee']),dataQuality:x.dq,win:f.away.yellow_cards>=2,refSample:Number(profile?.matches_sample??0),refScore:x.intel.score})}
      append(f)
    }

    const thresholds=Array.from({length:31},(_,i)=>60+i)
    const full=thresholds.map((t)=>stat(evaluated,'full',t)),old=thresholds.map((t)=>stat(evaluated,'old',t)),noRef=thresholds.map((t)=>stat(evaluated,'noRef',t))
    const best=(list:any[])=>list.filter((x)=>x.n>=50).sort((a,b)=>b.wilsonLow-a.wilsonLow||b.hitRate-a.hitRate)[0]??null
    const currentThreshold=70
    const summary={
      ok:true,job:JOB,targetSeason:'2025/26',targetFixtures,skippedLowHistory,evaluated:evaluated.length,
      methodology:'Strict chronological walk-forward. Every referee profile is rebuilt from that referee appointments BEFORE the tested fixture only. Missing red/foul values are excluded, never converted to zero.',
      currentThreshold:{full:stat(evaluated,'full',currentThreshold),oldYellowOnly:stat(evaluated,'old',currentThreshold),withoutReferee:stat(evaluated,'noRef',currentThreshold)},
      recommended:{full:best(full),oldYellowOnly:best(old),withoutReferee:best(noRef)},
      bySide:{home:stat(evaluated.filter((r)=>r.side==='home'),'full',currentThreshold),away:stat(evaluated.filter((r)=>r.side==='away'),'full',currentThreshold)},
      refereeCoverage:{with3Plus:evaluated.filter((r)=>r.refSample>=3).length,with10Plus:evaluated.filter((r)=>r.refSample>=10).length},
      fullThresholds:full,
      caveat:'Penalty-rate influence cannot be fully walk-forward validated from Football-Data because historical penalty-by-referee coverage is not present there. Its live weight is intentionally tiny and reliability-shrunk.',
    }
    await supabase.from('source_sync_runs').update({finished_at:new Date().toISOString(),status:'success',rows_upserted:evaluated.length,error_message:JSON.stringify(summary)}).eq('id',run.id)
    return new Response(JSON.stringify(summary),{headers:{'content-type':'application/json'}})
  }catch(error){const message=error instanceof Error?error.message:String(error);await supabase.from('source_sync_runs').update({finished_at:new Date().toISOString(),status:'failed',error_message:message}).eq('id',run.id);return new Response(JSON.stringify({ok:false,error:message}),{status:500,headers:{'content-type':'application/json'}})}
}
