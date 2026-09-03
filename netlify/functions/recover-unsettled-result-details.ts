import { createClient } from '@supabase/supabase-js'

const RESULT_LOOKBACK_MS = 10 * 24 * 60 * 60 * 1000
const OVERDUE_MS = 4 * 60 * 60 * 1000
const MAX_FIXTURES_PER_RUN = 40

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }
function norm(value:unknown){ return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g,'') }
function numberValue(value:unknown):number|null{
  const raw=typeof value==='object'&&value ? (value as any).value ?? (value as any).stat ?? (value as any).total : value
  if(typeof raw==='number') return Number.isFinite(raw)?raw:null
  if(typeof raw!=='string') return null
  const parsed=Number.parseFloat(raw.replace(/,/g,'').replace(/%/g,'').trim())
  return Number.isFinite(parsed)?parsed:null
}
function pairValue(value:unknown):[number,number]|null{
  if(Array.isArray(value)&&value.length>=2){
    const home=numberValue(value[0]),away=numberValue(value[1])
    return home!=null&&away!=null?[home,away]:null
  }
  if(!value||typeof value!=='object') return null
  const node=value as any
  const home=numberValue(node.home ?? node.homeValue ?? node.homeStat)
  const away=numberValue(node.away ?? node.awayValue ?? node.awayStat)
  if(home!=null&&away!=null) return [home,away]
  for(const key of ['stats','values','value','data']){
    const pair=pairValue(node[key]); if(pair) return pair
  }
  return null
}
function findPair(node:unknown,aliases:string[]):[number,number]|null{
  const wanted=aliases.map(norm)
  const matches=(value:unknown)=>{ const key=norm(value); return key.length>0&&wanted.some((alias)=>key===alias||key.includes(alias)||alias.includes(key)) }
  const visit=(value:unknown,depth:number):[number,number]|null=>{
    if(!value||depth>12) return null
    if(Array.isArray(value)){
      for(const item of value){ const found=visit(item,depth+1); if(found) return found }
      return null
    }
    if(typeof value!=='object') return null
    const object=value as Record<string,unknown>
    const label=object.title ?? object.name ?? object.key ?? object.label ?? object.statName ?? object.type
    if(matches(label)){ const direct=pairValue(object); if(direct) return direct }
    for(const [key,child] of Object.entries(object)){ if(matches(key)){ const direct=pairValue(child); if(direct) return direct } }
    for(const child of Object.values(object)){ if(child&&typeof child==='object'){ const found=visit(child,depth+1); if(found) return found } }
    return null
  }
  return visit(node,0)
}
function matchEvents(payload:any):any[]{
  const candidates=[payload?.content?.matchFacts?.events?.events,payload?.content?.matchFacts?.events,payload?.header?.events]
  for(const candidate of candidates) if(Array.isArray(candidate)) return candidate
  return []
}
function minuteOf(event:any):number|null{
  const raw=event?.time ?? event?.minute ?? event?.min
  if(typeof raw==='number'&&Number.isFinite(raw)) return raw
  const match=String(raw ?? '').match(/\d+/)
  return match?Number(match[0]):null
}
function halftimeFromEvents(payload:any,finalHome:number|null,finalAway:number|null):[number,number]|null{
  const explicit=findPair(payload,['half time score','halftime score','half-time score'])
  if(explicit) return [Math.round(explicit[0]),Math.round(explicit[1])]
  const events=matchEvents(payload)
  let latest:{minute:number;home:number;away:number}|null=null
  let scoreEventSeen=false
  for(const event of events){
    const home=numberValue(event?.homeScore ?? event?.home_score)
    const away=numberValue(event?.awayScore ?? event?.away_score)
    if(home==null||away==null) continue
    scoreEventSeen=true
    const minute=minuteOf(event)
    if(minute==null||minute>45) continue
    if(!latest||minute>=latest.minute) latest={minute,home,away}
  }
  if(latest) return [Math.round(latest.home),Math.round(latest.away)]
  if(finalHome===0&&finalAway===0) return [0,0]
  if(events.length&&scoreEventSeen) return [0,0]
  return null
}
async function fetchDetails(matchId:string){
  const urls=[
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ]
  let last='FotMob matchDetails failed'
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.6'}})
      if(!response.ok){ last=`${response.status} ${response.statusText}`; continue }
      const body=await response.json()
      if(body?.content||body?.general||body?.header) return body
    }catch(error){ last=error instanceof Error?error.message:String(error) }
  }
  throw new Error(last)
}
function detailStats(payload:any){
  return {
    yellow_cards:findPair(payload,['yellow cards','yellow card']),
    red_cards:findPair(payload,['red cards','red card']),
    corners:findPair(payload,['corners','corner kicks']),
    fouls:findPair(payload,['fouls committed','fouls']),
    shots:findPair(payload,['total shots','shots']),
    shots_on_target:findPair(payload,['shots on target','shotsontarget']),
    xg:findPair(payload,['expected goals','xg']),
    possession:findPair(payload,['ball possession','possession']),
  } as Record<string,[number,number]|null>
}
function chunks<T>(items:T[],size=80){ const out:T[][]=[]; for(let i=0;i<items.length;i+=size) out.push(items.slice(i,i+size)); return out }

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const nowMs=Date.now()
  const since=new Date(nowMs-RESULT_LOOKBACK_MS).toISOString()
  const overdue=new Date(nowMs-OVERDUE_MS).toISOString()

  const [scanner,combo]=await Promise.all([
    supabase.from('scanner_result_log')
      .select('fixtureId,kickoffUtc,fixtureStatus,outcome')
      .in('sourcePage',['best_bets','market_lab'])
      .eq('fixtureStatus','finished')
      .in('outcome',['pending','awaiting_data'])
      .gte('kickoffUtc',since)
      .lt('kickoffUtc',overdue)
      .limit(250),
    supabase.from('combo_result_log')
      .select('fixtureId,kickoffUtc,fixtureStatus,outcome')
      .eq('fixtureStatus','finished')
      .in('outcome',['pending','awaiting_data'])
      .gte('kickoffUtc',since)
      .lt('kickoffUtc',overdue)
      .limit(500),
  ])
  if(scanner.error) throw scanner.error
  if(combo.error) throw combo.error

  const unresolvedIds=[...new Set([...(scanner.data??[]),...(combo.data??[])].map((row:any)=>String(row.fixtureId??'')).filter(Boolean))].slice(0,MAX_FIXTURES_PER_RUN)
  if(!unresolvedIds.length){
    return new Response(JSON.stringify({ok:true,unresolvedFixtures:0,detailsChecked:0,detailsUpdated:0,statsRowsWritten:0,errors:[],warnings:[]}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
  }

  const fixtures:any[]=[]
  for(const batch of chunks(unresolvedIds)){
    const {data,error}=await supabase.from('fixtures')
      .select('id,source,source_fixture_id,home_team_id,away_team_id,home_goals,away_goals,status,kickoff')
      .in('id',batch)
    if(error) throw error
    fixtures.push(...(data??[]))
  }

  let detailsChecked=0,detailsUpdated=0,statsRowsWritten=0
  const errors:string[]=[],warnings:string[]=[]
  for(const fixture of fixtures){
    if(fixture.source!=='fotmob'||!fixture.source_fixture_id||fixture.status!=='finished') continue
    detailsChecked+=1
    let details:any
    try{ details=await fetchDetails(String(fixture.source_fixture_id)) }
    catch(error){ warnings.push(`${fixture.source_fixture_id}: ${error instanceof Error?error.message:String(error)}`); continue }

    const finalHome=numberValue(fixture.home_goals)
    const finalAway=numberValue(fixture.away_goals)
    const ht=halftimeFromEvents(details,finalHome,finalAway)
    if(ht){
      const {error}=await supabase.from('fixtures').update({half_time_home_goals:ht[0],half_time_away_goals:ht[1],updated_at:new Date().toISOString()}).eq('id',fixture.id)
      if(error) errors.push(`${fixture.source_fixture_id}: half-time update: ${error.message}`)
    }

    const pairs=detailStats(details)
    const sides=[
      {teamId:fixture.home_team_id,venue:'home',side:0 as const,goals:finalHome},
      {teamId:fixture.away_team_id,venue:'away',side:1 as const,goals:finalAway},
    ]
    let wrote=false
    for(const row of sides){
      if(!row.teamId) continue
      const statRow:Record<string,unknown>={fixture_id:fixture.id,team_id:row.teamId,venue:row.venue,goals:row.goals,source:'fotmob-match-details'}
      for(const [field,pair] of Object.entries(pairs)) if(pair) statRow[field]=pair[row.side]
      const {error}=await supabase.from('team_match_stats').upsert(statRow,{onConflict:'fixture_id,team_id'})
      if(error) errors.push(`${fixture.source_fixture_id}: ${row.venue} stats: ${error.message}`)
      else { statsRowsWritten+=1; wrote=true }
    }
    if(wrote) detailsUpdated+=1
    await new Promise((resolve)=>setTimeout(resolve,120))
  }

  return new Response(JSON.stringify({
    ok:true,
    unresolvedFixtures:unresolvedIds.length,
    fixturesConsidered:fixtures.length,
    detailsChecked,
    detailsUpdated,
    statsRowsWritten,
    errors,
    warnings:warnings.slice(0,40),
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
