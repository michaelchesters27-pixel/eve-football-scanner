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
  opponent_yellow_cards:number|null
  red_cards:number|null
  fouls:number|null
}
type RefMatch={kickoff:number;homeYellows:number;awayYellows:number;reds:number|null;fouls:number|null}
type Evidence={key:string;score:number}
type Evaluated={full:number;old:number;noRef:number;dataQuality:number;win:boolean;refSample:number;refScore:number}

const JOB='backtest-referee-v2-match-cards-2526'
const HISTORY_START='2024-07-01T00:00:00.000Z'
const TARGET_START='2025-07-01T00:00:00.000Z'
const TARGET_END='2026-07-01T00:00:00.000Z'
const WEIGHTS={recent:.18,venue:.25,opponent:.15,season:.12,h2h:.07,referee:.18,lineup:.05}

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function clamp(value:number,min=0,max=100){return Math.max(min,Math.min(max,value))}
function recent<T>(rows:T[],count:number){return rows.slice(Math.max(0,rows.length-count))}
function totalCards(row:MatchRow){return (row.yellow_cards??0)+(row.opponent_yellow_cards??0)}
function pct(rows:MatchRow[],test:(row:MatchRow)=>boolean){return rows.length?rows.filter(test).length/rows.length*100:0}
function avg(values:number[]){return values.length?values.reduce((a,b)=>a+b,0)/values.length:0}
function sampleQuality(parts:Array<[number,number,number]>){const tw=parts.reduce((s,[,,w])=>s+w,0);return tw?Math.round(parts.reduce((s,[a,t,w])=>s+clamp(a/t,0,1)*w,0)/tw*100):0}
function score(evidence:Evidence[],quality:number,omit:string[]=[]){let total=0,used=0;for(const item of evidence){const w=(WEIGHTS as any)[item.key] as number|undefined;if(!w||omit.includes(item.key))continue;total+=item.score*w;used+=w}const raw=used?total/used:0;return Math.round(raw*(.88+clamp(quality)/100*.12))}
function wilsonLow(wins:number,n:number){if(!n)return 0;const z=1.96,p=wins/n,d=1+z*z/n,c=p+z*z/(2*n),m=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n);return(c-m)/d*100}
function round1(n:number){return Math.round(n*10)/10}
function stat(rows:Evaluated[],field:'full'|'old'|'noRef',threshold:number){const selected=rows.filter((r)=>r.dataQuality>=70&&r[field]>=threshold),wins=selected.filter((r)=>r.win).length;return{threshold,n:selected.length,wins,hitRate:selected.length?round1(wins/selected.length*100):0,wilsonLow:round1(wilsonLow(wins,selected.length))}}

async function fetchRows(supabase:ReturnType<typeof createClient>){
  const out:MatchRow[]=[]
  for(let from=0;;from+=1000){
    const {data,error}=await supabase.from('team_match_flat')
      .select('fixture_id,kickoff,referee_id,team_id,opponent_team_id,venue,yellow_cards,opponent_yellow_cards,red_cards,fouls')
      .gte('kickoff',HISTORY_START).lt('kickoff',TARGET_END)
      .order('kickoff',{ascending:true}).order('fixture_id',{ascending:true}).range(from,from+999)
    if(error)throw error
    const page=(data??[]) as MatchRow[];out.push(...page);if(page.length<1000)break
  }
  return out
}

function refProfile(history:RefMatch[],cutoff:number):RefereeProfile|null{
  const rows=history.filter((r)=>r.kickoff<cutoff&&r.kickoff>=cutoff-730*86400000)
  if(rows.length<3)return null
  const reds=rows.map((r)=>r.reds).filter((v):v is number=>v!=null&&Number.isFinite(v))
  const fouls=rows.map((r)=>r.fouls).filter((v):v is number=>v!=null&&Number.isFinite(v))
  return{matches_sample:rows.length,yellow_cards_per_match:avg(rows.map((r)=>r.homeYellows+r.awayYellows)),red_cards_per_match:reds.length?avg(reds):null,fouls_per_match:fouls.length?avg(fouls):null,penalties_per_match:null,home_yellows_per_match:avg(rows.map((r)=>r.homeYellows)),away_yellows_per_match:avg(rows.map((r)=>r.awayYellows)),source:'eve-derived',sources:['eve-derived']}
}

function candidate(home:MatchRow[],away:MatchRow[],awayId:string,profile:RefereeProfile|null){
  const home10=recent(home,10),away10=recent(away,10),homeVenue=recent(home.filter((r)=>r.venue==='home'),10),awayVenue=recent(away.filter((r)=>r.venue==='away'),10),homeSeason=recent(home,30),awaySeason=recent(away,30),h2h=recent(home.filter((r)=>r.opponent_team_id===awayId),5)
  const tester=(r:MatchRow)=>totalCards(r)>=4
  const recentRate=(pct(home10,tester)+pct(away10,tester))/2
  const venueRate=(pct(homeVenue,tester)+pct(awayVenue,tester))/2
  const seasonRate=(pct(homeSeason,tester)+pct(awaySeason,tester))/2
  const h2hRate=pct(h2h,tester)
  const intel=buildRefereeIntelligence(profile,'match')
  const yellow=Number(profile?.yellow_cards_per_match??0)
  const oldRef=profile?clamp(40+(yellow-3)*17):50
  const common:Evidence[]=[{key:'recent',score:Math.round(recentRate)},{key:'venue',score:Math.round(venueRate)},{key:'opponent',score:Math.round(recentRate)},{key:'season',score:Math.round(seasonRate)},{key:'h2h',score:h2h.length?Math.round(h2hRate):50},{key:'lineup',score:50}]
  const full=[...common,{key:'referee',score:Math.round(intel.score)}],old=[...common,{key:'referee',score:Math.round(oldRef)}]
  const quality=sampleQuality([[home10.length+away10.length,20,22],[homeVenue.length+awayVenue.length,20,30],[homeSeason.length+awaySeason.length,50,18],[h2h.length,4,8],[0,14,10],[Number(profile?.matches_sample??0),10,12]])
  return{full,old,quality,intel}
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:run,error:runError}=await supabase.from('source_sync_runs').insert({source:'eve-backtest',job_name:JOB,status:'running'}).select('id').single()
  if(runError)throw runError
  try{
    const rows=await fetchRows(supabase)
    const fixtureMap=new Map<string,{kickoff:string;refereeId:string|null;home?:MatchRow;away?:MatchRow}>()
    for(const row of rows){const f=fixtureMap.get(row.fixture_id)??{kickoff:row.kickoff,refereeId:row.referee_id};if(row.venue==='home')f.home=row;else f.away=row;fixtureMap.set(row.fixture_id,f)}
    const fixtures=[...fixtureMap.values()].filter((f)=>f.home&&f.away).sort((a,b)=>Date.parse(a.kickoff)-Date.parse(b.kickoff)) as Array<{kickoff:string;refereeId:string|null;home:MatchRow;away:MatchRow}>
    const teamHistory=new Map<string,MatchRow[]>(),refHistory=new Map<string,RefMatch[]>(),evaluated:Evaluated[]=[]
    let targetFixtures=0,skippedLowHistory=0,skippedMissingOutcome=0
    const append=(f:typeof fixtures[number])=>{
      for(const row of [f.home,f.away]){const arr=teamHistory.get(row.team_id)??[];arr.push(row);teamHistory.set(row.team_id,arr)}
      if(f.refereeId&&f.home.yellow_cards!=null&&f.away.yellow_cards!=null){const arr=refHistory.get(f.refereeId)??[];const reds=f.home.red_cards!=null&&f.away.red_cards!=null?f.home.red_cards+f.away.red_cards:null;const fouls=f.home.fouls!=null&&f.away.fouls!=null?f.home.fouls+f.away.fouls:null;arr.push({kickoff:Date.parse(f.kickoff),homeYellows:f.home.yellow_cards,awayYellows:f.away.yellow_cards,reds,fouls});refHistory.set(f.refereeId,arr)}
    }
    for(const f of fixtures){
      const t=Date.parse(f.kickoff)
      if(f.kickoff<TARGET_START){append(f);continue}
      if(f.kickoff>=TARGET_END)break
      targetFixtures+=1
      const homeHistory=teamHistory.get(f.home.team_id)??[],awayHistory=teamHistory.get(f.away.team_id)??[]
      if(homeHistory.length<5||awayHistory.length<5){skippedLowHistory+=1;append(f);continue}
      if(f.home.yellow_cards==null||f.away.yellow_cards==null){skippedMissingOutcome+=1;append(f);continue}
      const profile=f.refereeId?refProfile(refHistory.get(f.refereeId)??[],t):null
      const x=candidate(homeHistory,awayHistory,f.away.team_id,profile)
      evaluated.push({full:score(x.full,x.quality),old:score(x.old,x.quality),noRef:score(x.full,x.quality,['referee']),dataQuality:x.quality,win:f.home.yellow_cards+f.away.yellow_cards>=4,refSample:Number(profile?.matches_sample??0),refScore:x.intel.score})
      append(f)
    }
    const thresholds=Array.from({length:31},(_,i)=>55+i),full=thresholds.map((t)=>stat(evaluated,'full',t)),old=thresholds.map((t)=>stat(evaluated,'old',t)),noRef=thresholds.map((t)=>stat(evaluated,'noRef',t))
    const best=(list:any[])=>list.filter((x)=>x.n>=80).sort((a,b)=>b.wilsonLow-a.wilsonLow||b.hitRate-a.hitRate)[0]??null
    const threshold=68
    const summary={ok:true,job:JOB,targetSeason:'2025/26',targetFixtures,skippedLowHistory,skippedMissingOutcome,evaluated:evaluated.length,methodology:'Strict chronological walk-forward for Match 4+ Yellow Cards. Referee intelligence uses prior appointments only. XI is neutral because historical confirmed-XI snapshots are not available.',currentThreshold:{full:stat(evaluated,'full',threshold),oldYellowOnly:stat(evaluated,'old',threshold),withoutReferee:stat(evaluated,'noRef',threshold)},recommended:{full:best(full),oldYellowOnly:best(old),withoutReferee:best(noRef)},refereeCoverage:{with3Plus:evaluated.filter((r)=>r.refSample>=3).length,with10Plus:evaluated.filter((r)=>r.refSample>=10).length},fullThresholds:full,caveat:'Penalty-rate influence cannot be validated from Football-Data historical referee data; live penalty weight remains very small and reliability-shrunk.'}
    await supabase.from('source_sync_runs').update({finished_at:new Date().toISOString(),status:'success',rows_upserted:evaluated.length,error_message:JSON.stringify(summary)}).eq('id',run.id)
    return new Response(JSON.stringify(summary),{headers:{'content-type':'application/json'}})
  }catch(error){const message=error instanceof Error?error.message:String(error);await supabase.from('source_sync_runs').update({finished_at:new Date().toISOString(),status:'failed',error_message:message}).eq('id',run.id);return new Response(JSON.stringify({ok:false,error:message}),{status:500,headers:{'content-type':'application/json'}})}
}
