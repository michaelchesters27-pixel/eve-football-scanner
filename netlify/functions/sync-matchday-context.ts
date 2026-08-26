import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '*/15 * * * *' }

const SOURCE = 'fotmob-matchday-auto'
const LOOKAHEAD_MINUTES = 180
const LOOKBACK_MINUTES = 150
const MAX_FIXTURES = 24

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }
function clean(value:string){ return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ') }
function slug(value:string){ return clean(value).replace(/ /g,'-') }
function num(value:any){ const n=Number(typeof value==='object'&&value?(value.value??value.stat??value.total??NaN):value); return Number.isFinite(n)?n:null }
function sleep(ms:number){ return new Promise((resolve)=>setTimeout(resolve,ms)) }
function text(value:any):string{
  if(value==null) return ''
  if(typeof value==='string'||typeof value==='number') return String(value).trim()
  if(typeof value==='object') return String(value.fullName??value.text??value.name??[value.firstName,value.lastName].filter(Boolean).join(' ')??'').trim()
  return ''
}
function flatten(value:any):any[]{
  if(!Array.isArray(value)) return []
  const out:any[]=[]
  for(const item of value){ if(Array.isArray(item)) out.push(...flatten(item)); else if(item!=null) out.push(item) }
  return out
}
function refereeSimilarity(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb) return 0
  if(aa===bb) return 1
  const at=aa.split(' ').filter(Boolean),bt=bb.split(' ').filter(Boolean)
  const aset=new Set(at),bset=new Set(bt)
  const common=[...aset].filter((token)=>bset.has(token)).length
  const overlap=common/Math.max(at.length,bt.length,1)
  const firstInitial=(at[0]?.[0]&&bt[0]?.[0]&&at[0][0]===bt[0][0])?1:0
  const lastSame=at.at(-1)===bt.at(-1)?1:0
  const penultimateSame=at.length>1&&bt.length>1&&at.at(-2)===bt.at(-2)?1:0
  const includes=aa.includes(bb)||bb.includes(aa)?1:0
  return Math.min(1,overlap*.58+lastSame*.18+penultimateSame*.12+firstInitial*.08+includes*.08)
}

type Starter={sourcePlayerId:string;name:string;position:string|null;shirtNumber:number|null}
type Fixture={id:string;source_fixture_id:string;kickoff:string;home_team_id:string;away_team_id:string;referee_id:string|null;match_context:any}

async function fetchDetails(matchId:string){
  const urls=[
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ]
  let last='FotMob match details failed'
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.8 matchday-auto-ref'}})
      if(!response.ok){ last=`${response.status} ${response.statusText}`; if(response.status===429) await sleep(1200); continue }
      const body=await response.json()
      if(body&&typeof body==='object') return body
      last='Unexpected FotMob match detail payload'
    }catch(error){ last=error instanceof Error?error.message:String(error) }
  }
  throw new Error(last)
}

function refereeName(payload:any){
  const raw=payload?.content?.matchFacts?.infoBox?.Referee
    ?? payload?.content?.matchFacts?.infoBox?.referee
    ?? payload?.general?.referee
  return text(raw)
}

function starterFrom(item:any):Starter|null{
  const p=item?.player??item
  const name=text(p?.name??p?.playerName??item?.name)
  if(!name||name==='[object Object]') return null
  const rawId=text(p?.id??p?.playerId??item?.id)
  const localized=p?.localizedPosition??item?.localizedPosition
  const position=text(p?.positionStringShort??p?.positionString??p?.position??localized?.label??localized?.text??item?.position) || null
  return {sourcePlayerId:rawId,name,position,shirtNumber:num(p?.shirtNumber??p?.shirt??item?.shirtNumber??item?.shirt)}
}

function currentSchemaGroups(payload:any){
  const groups=payload?.content?.lineup?.lineup
  if(!Array.isArray(groups)) return [] as Array<{teamId:string;players:any[]}>
  return groups.map((group:any)=>({teamId:text(group?.teamId??group?.team?.id),players:flatten(group?.players??group?.optaLineup?.players)}))
}

function legacyGroups(payload:any){
  const groups=payload?.content?.lineup?.lineups ?? payload?.content?.lineup2?.lineups
  if(!Array.isArray(groups)) return [] as Array<{teamId:string;players:any[]}>
  return groups.map((group:any)=>({teamId:text(group?.teamId??group?.team?.id),players:flatten(group?.players)}))
}

function extractStartingXIs(payload:any,fixture:Fixture){
  const line=payload?.content?.lineup
  if(line?.homeTeam&&line?.awayTeam){
    const home=flatten(line.homeTeam.starters).map(starterFrom).filter(Boolean) as Starter[]
    const away=flatten(line.awayTeam.starters).map(starterFrom).filter(Boolean) as Starter[]
    if(home.length>=11&&away.length>=11) return {home:home.slice(0,11),away:away.slice(0,11),schema:'homeTeam/awayTeam'}
  }
  const groups=[...currentSchemaGroups(payload),...legacyGroups(payload)]
  if(groups.length){
    const homeFotmob=text(fixture.match_context?.fotmob_home_team_id)
    const awayFotmob=text(fixture.match_context?.fotmob_away_team_id)
    const byTeam=new Map<string,Starter[]>()
    for(const group of groups){
      if(!group.teamId) continue
      const starters=group.players.map(starterFrom).filter(Boolean) as Starter[]
      if(starters.length>=11) byTeam.set(group.teamId,starters.slice(0,11))
    }
    const home=byTeam.get(homeFotmob)??[]
    const away=byTeam.get(awayFotmob)??[]
    if(home.length>=11&&away.length>=11) return {home:home.slice(0,11),away:away.slice(0,11),schema:'lineup array'}
  }
  return {home:[] as Starter[],away:[] as Starter[],schema:'none'}
}

function starterSignature(starters:Starter[]){ return starters.map((p)=>clean(p.name)).filter(Boolean).sort().join('|') }

async function existingOfficialSignatures(supabase:ReturnType<typeof createClient>,fixture:Fixture){
  const {data:rows,error}=await supabase.from('fixture_lineups').select('team_id,player_id').eq('fixture_id',fixture.id).eq('source','fotmob').eq('is_starting',true)
  if(error||!rows?.length) return {home:'',away:''}
  const ids=[...new Set(rows.map((r:any)=>r.player_id))]
  const {data:players}=ids.length?await supabase.from('players').select('id,name').in('id',ids):{data:[] as any[]}
  const names=new Map((players??[]).map((p:any)=>[p.id,clean(p.name)]))
  const teamSignature=(teamId:string)=>rows.filter((r:any)=>r.team_id===teamId).map((r:any)=>names.get(r.player_id)??'').filter(Boolean).sort().join('|')
  return {home:teamSignature(fixture.home_team_id),away:teamSignature(fixture.away_team_id)}
}

async function importOfficialLineups(supabase:ReturnType<typeof createClient>,fixture:Fixture,home:Starter[],away:Starter[]){
  if(home.length!==11||away.length!==11) return false
  const rows:any[]=[]
  for(const [teamId,starters] of [[fixture.home_team_id,home],[fixture.away_team_id,away]] as Array<[string,Starter[]]>){
    for(const starter of starters){
      const sourcePlayerId=starter.sourcePlayerId||`name:${teamId}:${slug(starter.name)}`
      const {data:player,error}=await supabase.from('players').upsert({source:'fotmob',source_player_id:sourcePlayerId,name:starter.name,current_team_id:teamId,position:starter.position,updated_at:new Date().toISOString()},{onConflict:'source,source_player_id'}).select('id').single()
      if(error||!player?.id) throw new Error(error?.message??`Could not save ${starter.name}`)
      rows.push({fixture_id:fixture.id,team_id:teamId,player_id:player.id,is_starting:true,shirt_number:starter.shirtNumber,position:starter.position,source:'fotmob',confirmed_at:new Date().toISOString()})
    }
  }
  const {error:deleteError}=await supabase.from('fixture_lineups').delete().eq('fixture_id',fixture.id).in('source',['fotmob','manual'])
  if(deleteError) throw deleteError
  const {error:insertError}=await supabase.from('fixture_lineups').insert(rows)
  if(insertError) throw insertError
  return true
}

async function importReferee(supabase:ReturnType<typeof createClient>,fixture:Fixture,name:string){
  if(!name) return {fixtureChanged:false,profileMatched:false,refereeId:fixture.referee_id,storedName:null as string|null,profileSample:0}
  const {data:refs,error:refsError}=await supabase.from('referees').select('id,name,source_key')
  if(refsError) throw refsError
  const ids=(refs??[]).map((r:any)=>r.id)
  const {data:profiles,error:profilesError}=ids.length?await supabase.from('referee_profiles').select('referee_id,matches_sample,as_of_date').in('referee_id',ids):{data:[] as any[],error:null}
  if(profilesError) throw profilesError
  const latestProfile=new Map<string,{matches:number;date:string}>()
  for(const row of profiles??[]){
    const prev=latestProfile.get(row.referee_id)
    const date=String(row.as_of_date??'')
    if(!prev||date>prev.date) latestProfile.set(row.referee_id,{matches:Number(row.matches_sample??0),date})
  }
  let best:any=null
  let bestNameScore=0
  let bestWeighted=0
  for(const ref of refs??[]){
    const nameScore=refereeSimilarity(name,String(ref.name??''))
    if(nameScore<0.72) continue
    const profile=latestProfile.get(ref.id)
    const profileBonus=profile?.matches?Math.min(.16,.06+profile.matches/250):0
    const historicalBonus=String(ref.source_key??'').startsWith('football-data:')?.025:0
    const weighted=nameScore+profileBonus+historicalBonus
    if(weighted>bestWeighted){ best=ref;bestNameScore=nameScore;bestWeighted=weighted }
  }

  let chosen=bestNameScore>=0.82?best:null
  if(!chosen){
    const sourceKey=`fotmob-ref:${slug(name)}`
    const {data:ref,error}=await supabase.from('referees').upsert({source_key:sourceKey,name},{onConflict:'source_key'}).select('id,name,source_key').single()
    if(error||!ref?.id) throw new Error(error?.message??'Referee upsert failed')
    chosen=ref
  }
  const profile=latestProfile.get(chosen.id)
  const fixtureChanged=fixture.referee_id!==chosen.id
  if(fixtureChanged){
    const {error:updateError}=await supabase.from('fixtures').update({referee_id:chosen.id,updated_at:new Date().toISOString()}).eq('id',fixture.id)
    if(updateError) throw updateError
    fixture.referee_id=chosen.id
  }
  return {fixtureChanged,profileMatched:Boolean(profile?.matches),refereeId:chosen.id as string,storedName:String(chosen.name??name),profileSample:Number(profile?.matches??0)}
}

async function triggerReanalysis(request:Request|undefined,fixtureId:string){
  try{
    const base=request?new URL(request.url).origin:process.env.URL
    if(!base) return false
    const target=new URL('/.netlify/functions/enrich-lineup-history-background',base)
    target.searchParams.set('fixture_id',fixtureId)
    const response=await fetch(target.toString(),{method:'GET'})
    return response.ok||response.status===202
  }catch{return false}
}

export default async(request?:Request)=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date()
  const requestedFixtureId=request?new URL(request.url).searchParams.get('fixture_id'):null
  const horizon=new Date(now.getTime()+LOOKAHEAD_MINUTES*60000)
  const floor=new Date(now.getTime()-LOOKBACK_MINUTES*60000)
  const {data:run}=await supabase.from('source_sync_runs').insert({source:SOURCE,job_name:'matchday-auto-sync',status:'running'}).select('id').single()

  try{
    let query=supabase.from('fixtures')
      .select('id,source_fixture_id,kickoff,home_team_id,away_team_id,referee_id,match_context')
      .eq('source','fotmob')
      .in('status',['scheduled','live'])
      .order('kickoff',{ascending:true})
      .limit(MAX_FIXTURES)
    if(requestedFixtureId) query=query.eq('id',requestedFixtureId)
    else query=query.gte('kickoff',floor.toISOString()).lte('kickoff',horizon.toISOString())
    const {data:fixtures,error}=await query
    if(error) throw error

    const fixtureIds=(fixtures??[]).map((f:any)=>f.id)
    const contextMap=new Map<string,any>()
    if(fixtureIds.length){
      const {data:contexts}=await supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed,lineups_confirmed').in('fixture_id',fixtureIds)
      for(const row of contexts??[]) contextMap.set(row.fixture_id,row)
    }

    const results:any[]=[]
    let changed=0,lineupsImported=0,refsImported=0,reanalysisTriggered=0
    for(const fixtureRaw of fixtures??[]){
      const fixture=fixtureRaw as Fixture
      const previous=contextMap.get(fixture.id)??{}
      try{
        const payload=await fetchDetails(String(fixture.source_fixture_id))
        const refName=refereeName(payload)
        const lineups=extractStartingXIs(payload,fixture)
        const fullLineups=lineups.home.length===11&&lineups.away.length===11
        const refChanged=Boolean(refName)&&(!previous.referee_confirmed||clean(text(previous.referee_name))!==clean(refName))
        const refResolution=refName?await importReferee(supabase,fixture,refName):{fixtureChanged:false,profileMatched:false,refereeId:fixture.referee_id,storedName:null,profileSample:0}
        if(refResolution.fixtureChanged) refsImported+=1
        let lineupChanged=false
        if(fullLineups){
          const existing=await existingOfficialSignatures(supabase,fixture)
          lineupChanged=!previous.lineups_confirmed||existing.home!==starterSignature(lineups.home)||existing.away!==starterSignature(lineups.away)
        }
        if(fullLineups&&lineupChanged){ if(await importOfficialLineups(supabase,fixture,lineups.home,lineups.away)) lineupsImported+=1 }

        const materialChanged=refChanged||refResolution.fixtureChanged||lineupChanged
        if(materialChanged){
          changed+=1
          const {error:contextError}=await supabase.from('manual_match_context').upsert({fixture_id:fixture.id,referee_name:refName||previous.referee_name||null,referee_confirmed:Boolean(refName)||Boolean(previous.referee_confirmed),lineups_confirmed:fullLineups||Boolean(previous.lineups_confirmed),confirmed_at:new Date().toISOString(),updated_at:new Date().toISOString()},{onConflict:'fixture_id'})
          if(contextError) throw contextError
          if(await triggerReanalysis(request,fixture.id)) reanalysisTriggered+=1
        }

        results.push({fixtureId:fixture.id,kickoff:fixture.kickoff,referee:refName||null,refereeStoredAs:refResolution.storedName,refereeProfileMatched:refResolution.profileMatched,refereeProfileSample:refResolution.profileSample,homeStarters:lineups.home.length,awayStarters:lineups.away.length,schema:lineups.schema,changed:materialChanged,status:fullLineups?(lineupChanged?'official_lineups_updated':'official_lineups_confirmed'):refName?'referee_found_waiting_lineups':'awaiting_matchday_data'})
      }catch(error){ results.push({fixtureId:fixture.id,kickoff:fixture.kickoff,status:'error',error:error instanceof Error?error.message:String(error)}) }
      await sleep(130)
    }

    const errors=results.filter((r)=>r.status==='error').length
    const summary={fixturesChecked:fixtures?.length??0,changed,lineupsImported,refsImported,reanalysisTriggered,errors,lookaheadMinutes:LOOKAHEAD_MINUTES,lookbackMinutes:LOOKBACK_MINUTES,results:results.slice(0,24)}
    if(run?.id) await supabase.from('source_sync_runs').update({status:errors?'partial':'success',rows_upserted:lineupsImported*22+refsImported,finished_at:new Date().toISOString(),error_message:JSON.stringify(summary).slice(0,5000)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:true,...summary,note:'Official XI/referee data is checked every 15 minutes. Confirmed referees are reconciled to EVE historical referee identities when possible so their rolling card/foul profile can be used immediately.'}),{headers:{'content-type':'application/json'}})
  }catch(error){
    if(run?.id) await supabase.from('source_sync_runs').update({status:'failed',finished_at:new Date().toISOString(),error_message:error instanceof Error?error.message:String(error)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'content-type':'application/json'}})
  }
}
