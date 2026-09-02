import { createClient } from '@supabase/supabase-js'

const SOURCE='fotmob-matchday-hardened'
const LOOKBACK_MS=3*60*60*1000
const LOOKAHEAD_MS=7*24*60*60*1000
const OFFICIAL_WINDOW_MS=90*60*1000
const CONCURRENCY=6

type Starter={sourcePlayerId:string;name:string;position:string|null;shirtNumber:number|null}
type Fixture={id:string;source_fixture_id:string;kickoff:string;status:string;home_team_id:string;away_team_id:string;match_context:any}

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function clean(value:string){return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
function slug(value:string){return clean(value).replace(/ /g,'-')}
function num(value:any){const n=Number(typeof value==='object'&&value?(value.value??value.stat??value.total??NaN):value);return Number.isFinite(n)?n:null}
function text(value:any):string{
  if(value==null) return ''
  if(typeof value==='string'||typeof value==='number') return String(value).trim()
  if(typeof value==='object') return String(value.fullName??value.text??value.name??[value.firstName,value.lastName].filter(Boolean).join(' ')??'').trim()
  return ''
}
function flatten(value:any):any[]{
  if(!Array.isArray(value)) return []
  const out:any[]=[]
  for(const item of value){if(Array.isArray(item)) out.push(...flatten(item));else if(item!=null) out.push(item)}
  return out
}
function chunks<T>(items:T[],size:number){const out:T[][]=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out}
function sleep(ms:number){return new Promise((resolve)=>setTimeout(resolve,ms))}

async function fetchDetails(matchId:string){
  const urls=[
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ]
  let last='FotMob match details failed'
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/1.3 hardened-matchday'}})
      if(!response.ok){last=`${response.status} ${response.statusText}`;if(response.status===429) await sleep(900);continue}
      const body=await response.json()
      if(body&&typeof body==='object') return body
      last='Unexpected FotMob match detail payload'
    }catch(error){last=error instanceof Error?error.message:String(error)}
  }
  throw new Error(last)
}

async function officialLineupState(matchId:string):Promise<'official'|'predicted'|'unknown'> {
  if(!matchId) return 'unknown'
  try{
    const response=await fetch(`https://www.fotmob.com/match/${encodeURIComponent(matchId)}`,{
      redirect:'follow',
      headers:{accept:'text/html,application/xhtml+xml','user-agent':'Mozilla/5.0 EVE-Football-Scanner/1.3 lineup-verifier'},
    })
    if(!response.ok) return 'unknown'
    const html=await response.text()
    if(/the lineups are\s*:/i.test(html)||/"(?:isLineupConfirmed|lineupConfirmed|isConfirmed)"\s*:\s*true/i.test(html)) return 'official'
    if(/current predicted lineups are\s*:/i.test(html)||/>\s*Predicted lineup\s*</i.test(html)||/"(?:isPredicted|predicted)"\s*:\s*true/i.test(html)) return 'predicted'
    return 'unknown'
  }catch{return 'unknown'}
}

function refereeName(payload:any){
  return text(payload?.content?.matchFacts?.infoBox?.Referee
    ??payload?.content?.matchFacts?.infoBox?.referee
    ??payload?.general?.referee)
}

function starterFrom(item:any):Starter|null{
  const p=item?.player??item
  const name=text(p?.name??p?.playerName??item?.name)
  if(!name||name==='[object Object]') return null
  const rawId=text(p?.id??p?.playerId??item?.id)
  const localized=p?.localizedPosition??item?.localizedPosition
  const position=text(p?.positionStringShort??p?.positionString??p?.position??localized?.label??localized?.text??item?.position)||null
  return {sourcePlayerId:rawId,name,position,shirtNumber:num(p?.shirtNumber??p?.shirt??item?.shirtNumber??item?.shirt)}
}

function extractStartingXIs(payload:any,fixture:Fixture){
  const line=payload?.content?.lineup
  if(line?.homeTeam&&line?.awayTeam){
    const home=flatten(line.homeTeam.starters).map(starterFrom).filter(Boolean) as Starter[]
    const away=flatten(line.awayTeam.starters).map(starterFrom).filter(Boolean) as Starter[]
    if(home.length>=11&&away.length>=11) return {home:home.slice(0,11),away:away.slice(0,11),schema:'homeTeam/awayTeam'}
  }
  const rawGroups=[
    ...(Array.isArray(payload?.content?.lineup?.lineup)?payload.content.lineup.lineup:[]),
    ...(Array.isArray(payload?.content?.lineup?.lineups)?payload.content.lineup.lineups:[]),
    ...(Array.isArray(payload?.content?.lineup2?.lineups)?payload.content.lineup2.lineups:[]),
  ]
  if(rawGroups.length){
    const homeFotmob=text(fixture.match_context?.fotmob_home_team_id)
    const awayFotmob=text(fixture.match_context?.fotmob_away_team_id)
    const byTeam=new Map<string,Starter[]>()
    for(const group of rawGroups){
      const teamId=text(group?.teamId??group?.team?.id)
      if(!teamId) continue
      const players=flatten(group?.players??group?.optaLineup?.players).map(starterFrom).filter(Boolean) as Starter[]
      if(players.length>=11) byTeam.set(teamId,players.slice(0,11))
    }
    const home=byTeam.get(homeFotmob)??[]
    const away=byTeam.get(awayFotmob)??[]
    if(home.length>=11&&away.length>=11) return {home:home.slice(0,11),away:away.slice(0,11),schema:'lineup-array'}
  }
  return {home:[] as Starter[],away:[] as Starter[],schema:'none'}
}

async function importOfficialLineups(supabase:ReturnType<typeof createClient>,fixture:Fixture,home:Starter[],away:Starter[]){
  if(home.length!==11||away.length!==11) throw new Error('Official lineup import requires exactly 11+11 starters')
  const rows:any[]=[]
  for(const [teamId,starters] of [[fixture.home_team_id,home],[fixture.away_team_id,away]] as Array<[string,Starter[]]>){
    for(const starter of starters){
      const sourcePlayerId=starter.sourcePlayerId||`name:${teamId}:${slug(starter.name)}`
      const {data:player,error}=await supabase.from('players').upsert({
        source:'fotmob',source_player_id:sourcePlayerId,name:starter.name,current_team_id:teamId,
        position:starter.position,updated_at:new Date().toISOString(),
      },{onConflict:'source,source_player_id'}).select('id').single()
      if(error||!player?.id) throw new Error(error?.message??`Could not save ${starter.name}`)
      rows.push({fixture_id:fixture.id,team_id:teamId,player_id:player.id,is_starting:true,shirt_number:starter.shirtNumber,position:starter.position,source:'fotmob',confirmed_at:new Date().toISOString()})
    }
  }
  const {error:deleteError}=await supabase.from('fixture_lineups').delete().eq('fixture_id',fixture.id).eq('source','fotmob')
  if(deleteError) throw deleteError
  const {error:insertError}=await supabase.from('fixture_lineups').insert(rows)
  if(insertError) throw insertError
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date()
  const from=new Date(now.getTime()-LOOKBACK_MS).toISOString()
  const to=new Date(now.getTime()+LOOKAHEAD_MS).toISOString()
  const {data:run}=await supabase.from('source_sync_runs').insert({source:SOURCE,job_name:'hourly-pre-match-intelligence',status:'running'}).select('id').single()

  try{
    const {data:fixtures,error}=await supabase.from('fixtures')
      .select('id,source_fixture_id,kickoff,status,home_team_id,away_team_id,match_context')
      .eq('source','fotmob')
      .in('status',['scheduled','live'])
      .gte('kickoff',from)
      .lte('kickoff',to)
      .order('kickoff',{ascending:true})
    if(error) throw error

    const fixtureRows=(fixtures??[]) as Fixture[]
    const ids=fixtureRows.map((f)=>f.id)
    const contexts:any[]=[]
    for(const batch of chunks(ids,100)){
      const {data,error:ctxError}=await supabase.from('manual_match_context')
        .select('fixture_id,referee_name,referee_confirmed,lineups_confirmed')
        .in('fixture_id',batch)
      if(ctxError) throw ctxError
      contexts.push(...(data??[]))
    }
    const contextMap=new Map(contexts.map((x:any)=>[x.fixture_id,x]))

    const results:any[]=[]
    let refereesConfirmed=0,lineupsImported=0,changed=0

    const processFixture=async(fixture:Fixture)=>{
      const previous=contextMap.get(fixture.id)??{}
      const payload=await fetchDetails(String(fixture.source_fixture_id))
      const refName=refereeName(payload)
      const lineups=extractStartingXIs(payload,fixture)
      const full=lineups.home.length===11&&lineups.away.length===11
      const kickoffMs=Date.parse(fixture.kickoff)
      const distance=kickoffMs-Date.now()
      const insideOfficialWindow=distance<=OFFICIAL_WINDOW_MS&&distance>=-30*60*1000
      let lineupState:'official'|'predicted'|'unknown'='unknown'
      let lineupAccepted=false
      if(full){
        if(fixture.status==='live') {lineupState='official';lineupAccepted=true}
        else if(insideOfficialWindow){
          lineupState=await officialLineupState(String(fixture.source_fixture_id))
          lineupAccepted=lineupState==='official'
        }
      }

      const refChanged=Boolean(refName)&&(!previous.referee_confirmed||clean(String(previous.referee_name??''))!==clean(refName))
      let lineupChanged=false
      if(lineupAccepted){
        await importOfficialLineups(supabase,fixture,lineups.home,lineups.away)
        lineupChanged=!previous.lineups_confirmed
        lineupsImported+=1
      }
      if(refName&&refChanged) refereesConfirmed+=1
      const materialChanged=refChanged||lineupChanged
      if(materialChanged) changed+=1

      if(refName||lineupAccepted){
        const {error:contextError}=await supabase.from('manual_match_context').upsert({
          fixture_id:fixture.id,
          referee_name:refName||previous.referee_name||null,
          referee_confirmed:Boolean(refName)||Boolean(previous.referee_confirmed),
          lineups_confirmed:lineupAccepted||Boolean(previous.lineups_confirmed),
          confirmed_at:new Date().toISOString(),
          updated_at:new Date().toISOString(),
        },{onConflict:'fixture_id'})
        if(contextError) throw contextError
      }

      return {
        fixtureId:fixture.id,kickoff:fixture.kickoff,status:fixture.status,referee:refName||null,
        homeStarters:lineups.home.length,awayStarters:lineups.away.length,lineupSchema:lineups.schema,
        lineupCandidate:full,insideOfficialWindow,lineupSourceState:lineupState,lineupAccepted,
        changed:materialChanged,
      }
    }

    for(const batch of chunks(fixtureRows,CONCURRENCY)){
      const settled=await Promise.allSettled(batch.map((fixture)=>processFixture(fixture)))
      settled.forEach((result,index)=>{
        if(result.status==='fulfilled') results.push(result.value)
        else results.push({fixtureId:batch[index].id,kickoff:batch[index].kickoff,status:'error',error:result.reason instanceof Error?result.reason.message:String(result.reason)})
      })
      await sleep(80)
    }

    const errors=results.filter((r)=>r.status==='error').length
    const summary={
      fixturesChecked:fixtureRows.length,changed,refereesConfirmed,lineupsImported,errors,
      lookaheadDays:7,noFixtureCap:true,concurrency:CONCURRENCY,
      lineupRule:'Predicted/probable 11+11 data is never written. Scheduled FotMob lineups require 11+11, <=90 minutes to kickoff, and positive public FotMob evidence that the actual lineup is announced. Unknown source state fails closed. Live-match 11+11 data is accepted.',
      results:results.slice(0,200),
    }
    if(run?.id) await supabase.from('source_sync_runs').update({
      status:errors?'partial':'success',rows_upserted:lineupsImported*22+refereesConfirmed,
      finished_at:new Date().toISOString(),error_message:JSON.stringify(summary).slice(0,5000),
    }).eq('id',run.id)
    return new Response(JSON.stringify({ok:errors===0,...summary}),{
      status:errors?500:200,
      headers:{'content-type':'application/json','cache-control':'no-store'},
    })
  }catch(error){
    if(run?.id) await supabase.from('source_sync_runs').update({status:'failed',finished_at:new Date().toISOString(),error_message:error instanceof Error?error.message:String(error)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'content-type':'application/json','cache-control':'no-store'}})
  }
}
