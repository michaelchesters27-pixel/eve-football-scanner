import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '*/15 * * * *' }

const SOURCE = 'fotmob-matchday-auto'
const LOOKAHEAD_MINUTES = 135
const MAX_FIXTURES = 24

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }
function clean(value:string){ return value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ') }
function slug(value:string){ return clean(value).replace(/ /g,'-') }
function num(value:any){ const n=Number(typeof value==='object'&&value?(value.value??value.stat??value.total??NaN):value); return Number.isFinite(n)?n:null }
function sleep(ms:number){ return new Promise((resolve)=>setTimeout(resolve,ms)) }

type Starter = { sourcePlayerId:string; name:string; position:string|null; shirtNumber:number|null }
type Fixture = {
  id:string
  source_fixture_id:string
  kickoff:string
  home_team_id:string
  away_team_id:string
  match_context:any
}

async function fetchDetails(matchId:string){
  const urls=[
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ]
  let last='FotMob match details failed'
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.6 matchday-auto'}})
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
  if(typeof raw==='string') return raw.trim()
  return String(raw?.text??raw?.name??'').trim()
}

function starterFrom(item:any):Starter|null{
  const p=item?.player??item
  const name=String(p?.name??p?.playerName??item?.name??'').trim()
  if(!name) return null
  const rawId=String(p?.id??p?.playerId??item?.id??'').trim()
  const position=String(p?.positionString??p?.position??item?.position??'').trim()||null
  return {
    sourcePlayerId:rawId,
    name,
    position,
    shirtNumber:num(p?.shirtNumber??item?.shirtNumber),
  }
}

function extractStartingXIs(payload:any,fixture:Fixture){
  const direct=payload?.content?.lineup
  if(direct?.homeTeam&&direct?.awayTeam){
    const homeRaw=Array.isArray(direct.homeTeam.starters)?direct.homeTeam.starters:[]
    const awayRaw=Array.isArray(direct.awayTeam.starters)?direct.awayTeam.starters:[]
    const home=homeRaw.map(starterFrom).filter(Boolean) as Starter[]
    const away=awayRaw.map(starterFrom).filter(Boolean) as Starter[]
    if(home.length>=11&&away.length>=11) return {home:home.slice(0,11),away:away.slice(0,11)}
  }

  const groups=payload?.content?.lineup?.lineups ?? payload?.content?.lineup2?.lineups
  if(Array.isArray(groups)){
    const homeFotmob=String(fixture.match_context?.fotmob_home_team_id??'')
    const awayFotmob=String(fixture.match_context?.fotmob_away_team_id??'')
    const byTeam=new Map<string,Starter[]>()
    for(const group of groups){
      const teamId=String(group?.teamId??group?.team?.id??'')
      const raw=Array.isArray(group?.players)?group.players:[]
      const starters=raw.filter((item:any,index:number)=>{
        const p=item?.player??item
        const explicit=p?.isStarter??item?.isStarter??item?.starter
        return typeof explicit==='boolean'?explicit:index<11
      }).map(starterFrom).filter(Boolean) as Starter[]
      byTeam.set(teamId,starters.slice(0,11))
    }
    const home=byTeam.get(homeFotmob)??[]
    const away=byTeam.get(awayFotmob)??[]
    if(home.length>=11&&away.length>=11) return {home:home.slice(0,11),away:away.slice(0,11)}
  }

  return {home:[] as Starter[],away:[] as Starter[]}
}

function starterSignature(starters:Starter[]){
  return starters.map((p)=>clean(p.name)).filter(Boolean).sort().join('|')
}

async function existingOfficialSignatures(supabase:ReturnType<typeof createClient>,fixture:Fixture){
  const {data:rows,error}=await supabase.from('fixture_lineups').select('team_id,player_id').eq('fixture_id',fixture.id).eq('source','fotmob').eq('is_starting',true)
  if(error||!rows?.length) return {home:'',away:''}
  const ids=[...new Set(rows.map((r:any)=>r.player_id))]
  const {data:players}=await supabase.from('players').select('id,name').in('id',ids)
  const names=new Map((players??[]).map((p:any)=>[p.id,clean(p.name)]))
  const teamSignature=(teamId:string)=>rows.filter((r:any)=>r.team_id===teamId).map((r:any)=>names.get(r.player_id)??'').filter(Boolean).sort().join('|')
  return {home:teamSignature(fixture.home_team_id),away:teamSignature(fixture.away_team_id)}
}

async function importOfficialLineups(supabase:ReturnType<typeof createClient>,fixture:Fixture,home:Starter[],away:Starter[]){
  if(home.length!==11||away.length!==11) return {imported:false,home:home.length,away:away.length}
  const rows:any[]=[]
  for(const [teamId,starters] of [[fixture.home_team_id,home],[fixture.away_team_id,away]] as Array<[string,Starter[]]>){
    for(const starter of starters){
      const sourcePlayerId=starter.sourcePlayerId||`name:${teamId}:${slug(starter.name)}`
      const {data:player,error}=await supabase.from('players').upsert({
        source:'fotmob',
        source_player_id:sourcePlayerId,
        name:starter.name,
        current_team_id:teamId,
        position:starter.position,
        updated_at:new Date().toISOString(),
      },{onConflict:'source,source_player_id'}).select('id').single()
      if(error||!player?.id) throw new Error(error?.message??`Could not save ${starter.name}`)
      rows.push({
        fixture_id:fixture.id,
        team_id:teamId,
        player_id:player.id,
        is_starting:true,
        shirt_number:starter.shirtNumber,
        position:starter.position,
        source:'fotmob',
        confirmed_at:new Date().toISOString(),
      })
    }
  }

  // Official data supersedes any temporary/manual XI to avoid duplicate starters.
  const {error:deleteError}=await supabase.from('fixture_lineups').delete().eq('fixture_id',fixture.id).in('source',['fotmob','manual'])
  if(deleteError) throw deleteError
  const {error:insertError}=await supabase.from('fixture_lineups').insert(rows)
  if(insertError) throw insertError
  return {imported:true,home:11,away:11}
}

async function importReferee(supabase:ReturnType<typeof createClient>,fixtureId:string,name:string){
  if(!name) return {imported:false,refereeId:null as string|null}
  const sourceKey=`fotmob-ref:${slug(name)}`
  const {data:ref,error}=await supabase.from('referees').upsert({source_key:sourceKey,name},{onConflict:'source_key'}).select('id').single()
  if(error||!ref?.id) throw new Error(error?.message??'Referee upsert failed')
  const {error:updateError}=await supabase.from('fixtures').update({referee_id:ref.id,updated_at:new Date().toISOString()}).eq('id',fixtureId)
  if(updateError) throw updateError
  return {imported:true,refereeId:ref.id as string}
}

async function triggerReanalysis(request:Request|undefined,fixtureId:string){
  try{
    const base=request?new URL(request.url).origin:process.env.URL
    if(!base) return false
    const target=new URL('/.netlify/functions/enrich-lineup-history-background',base)
    target.searchParams.set('fixture_id',fixtureId)
    const response=await fetch(target.toString(),{method:'GET'})
    return response.ok||response.status===202
  }catch{ return false }
}

export default async(request?:Request)=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date()
  const requestedFixtureId=request?new URL(request.url).searchParams.get('fixture_id'):null
  const horizon=new Date(now.getTime()+LOOKAHEAD_MINUTES*60000)

  const {data:run}=await supabase.from('source_sync_runs').insert({source:SOURCE,job_name:'matchday-auto-sync',status:'running'}).select('id').single()

  try{
    let query=supabase.from('fixtures')
      .select('id,source_fixture_id,kickoff,home_team_id,away_team_id,match_context')
      .eq('source','fotmob')
      .in('status',['scheduled','live'])
      .order('kickoff',{ascending:true})
      .limit(MAX_FIXTURES)
    if(requestedFixtureId){
      query=query.eq('id',requestedFixtureId)
    }else{
      query=query.gte('kickoff',new Date(now.getTime()-30*60000).toISOString()).lte('kickoff',horizon.toISOString())
    }
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
        const refChanged=Boolean(refName)&&(!previous.referee_confirmed||clean(String(previous.referee_name??''))!==clean(refName))

        let lineupChanged=false
        if(fullLineups){
          const existing=await existingOfficialSignatures(supabase,fixture)
          lineupChanged=!previous.lineups_confirmed||existing.home!==starterSignature(lineups.home)||existing.away!==starterSignature(lineups.away)
        }

        if(refName&&refChanged){ await importReferee(supabase,fixture.id,refName); refsImported+=1 }
        if(fullLineups&&lineupChanged){
          const imported=await importOfficialLineups(supabase,fixture,lineups.home,lineups.away)
          if(imported.imported) lineupsImported+=1
        }

        if(refChanged||lineupChanged){
          changed+=1
          const {error:contextError}=await supabase.from('manual_match_context').upsert({
            fixture_id:fixture.id,
            referee_name:refName||previous.referee_name||null,
            referee_confirmed:Boolean(refName)||Boolean(previous.referee_confirmed),
            lineups_confirmed:fullLineups||Boolean(previous.lineups_confirmed),
            confirmed_at:new Date().toISOString(),
            updated_at:new Date().toISOString(),
          },{onConflict:'fixture_id'})
          if(contextError) throw contextError
          if(await triggerReanalysis(request,fixture.id)) reanalysisTriggered+=1
        }

        results.push({
          fixtureId:fixture.id,
          kickoff:fixture.kickoff,
          referee:refName||null,
          homeStarters:lineups.home.length,
          awayStarters:lineups.away.length,
          changed:refChanged||lineupChanged,
          status:fullLineups?(lineupChanged?'official_lineups_updated':'official_lineups_confirmed'):refName?'referee_found_waiting_lineups':'awaiting_matchday_data',
        })
      }catch(error){
        results.push({fixtureId:fixture.id,kickoff:fixture.kickoff,status:'error',error:error instanceof Error?error.message:String(error)})
      }
      await sleep(130)
    }

    const errors=results.filter((r)=>r.status==='error').length
    const summary={fixturesChecked:fixtures?.length??0,changed,lineupsImported,refsImported,reanalysisTriggered,errors,lookaheadMinutes:LOOKAHEAD_MINUTES,results:results.slice(0,24)}
    if(run?.id) await supabase.from('source_sync_runs').update({status:errors?'partial':'success',rows_upserted:lineupsImported*22+refsImported,finished_at:new Date().toISOString(),error_message:JSON.stringify(summary).slice(0,5000)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:true,...summary,note:'EVE checks match details every 15 minutes inside roughly two hours of kickoff. Official referee and 11+11 starting XIs are imported automatically; late XI/referee changes are detected and trigger another re-analysis.'}),{headers:{'content-type':'application/json'}})
  }catch(error){
    if(run?.id) await supabase.from('source_sync_runs').update({status:'failed',finished_at:new Date().toISOString(),error_message:error instanceof Error?error.message:String(error)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'content-type':'application/json'}})
  }
}
