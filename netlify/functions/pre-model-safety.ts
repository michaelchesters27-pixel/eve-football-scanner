import { createClient } from '@supabase/supabase-js'

const LOOKBACK_MS = 3 * 60 * 60 * 1000
const LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000
const FOTMOB_OFFICIAL_WINDOW_MS = 90 * 60 * 1000

function env(name:string){
  const value=process.env[name]
  if(!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function chunks<T>(items:T[],size=100){
  const out:T[][]=[]
  for(let i=0;i<items.length;i+=size) out.push(items.slice(i,i+size))
  return out
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date()
  const from=new Date(now.getTime()-LOOKBACK_MS).toISOString()
  const to=new Date(now.getTime()+LOOKAHEAD_MS).toISOString()

  const {data:fixtures,error:fixtureError}=await supabase.from('fixtures')
    .select('id,kickoff,status,home_team_id,away_team_id,referee_id')
    .in('status',['scheduled','live'])
    .gte('kickoff',from)
    .lte('kickoff',to)
    .order('kickoff',{ascending:true})
  if(fixtureError) throw fixtureError

  const fixtureRows=fixtures??[]
  const ids=fixtureRows.map((f:any)=>f.id)
  const contexts:any[]=[]
  for(const batch of chunks(ids)){
    const {data,error}=await supabase.from('manual_match_context')
      .select('fixture_id,referee_name,referee_confirmed,lineups_confirmed,confirmed_at,updated_at')
      .in('fixture_id',batch)
    if(error) throw error
    contexts.push(...(data??[]))
  }
  const contextMap=new Map(contexts.map((row:any)=>[row.fixture_id,row]))

  const refsToClear:string[]=[]
  const lineupContextsToClear:string[]=[]
  const lineupRowsToDelete:string[]=[]
  const keptOfficialLineups:string[]=[]
  const details:any[]=[]

  for(const fixture of fixtureRows as any[]){
    const context=contextMap.get(fixture.id)??{}
    const refereeConfirmed=Boolean(context.referee_confirmed&&String(context.referee_name??'').trim())
    if(fixture.referee_id&&!refereeConfirmed) refsToClear.push(fixture.id)

    const {data:lineups,error:lineupError}=await supabase.from('fixture_lineups')
      .select('team_id,source,confirmed_at,is_starting')
      .eq('fixture_id',fixture.id)
      .eq('is_starting',true)
    if(lineupError) throw lineupError

    const rows=lineups??[]
    const count=(teamId:string,source?:string)=>rows.filter((r:any)=>r.team_id===teamId&&(!source||r.source===source)).length
    const homeAll=count(fixture.home_team_id)
    const awayAll=count(fixture.away_team_id)
    const homeManual=count(fixture.home_team_id,'manual')
    const awayManual=count(fixture.away_team_id,'manual')
    const homeFotmob=count(fixture.home_team_id,'fotmob')
    const awayFotmob=count(fixture.away_team_id,'fotmob')
    const completeAll=homeAll===11&&awayAll===11
    const completeManual=homeManual===11&&awayManual===11
    const completeFotmob=homeFotmob===11&&awayFotmob===11
    const fotmobTimes=rows.filter((r:any)=>r.source==='fotmob'&&r.confirmed_at).map((r:any)=>Date.parse(r.confirmed_at)).filter(Number.isFinite)
    const latestFotmob=fotmobTimes.length?Math.max(...fotmobTimes):NaN
    const kickoffMs=Date.parse(fixture.kickoff)
    const closeEnough=Number.isFinite(latestFotmob)&&latestFotmob<=kickoffMs+30*60*1000&&(kickoffMs-latestFotmob)<=FOTMOB_OFFICIAL_WINDOW_MS
    const fotmobOfficial=completeFotmob&&(fixture.status==='live'||closeEnough)
    const validConfirmed=completeAll&&(completeManual||fotmobOfficial)

    if(context.lineups_confirmed&&!validConfirmed){
      lineupContextsToClear.push(fixture.id)
      if(rows.some((r:any)=>r.source==='fotmob')) lineupRowsToDelete.push(fixture.id)
    }else if(context.lineups_confirmed&&validConfirmed){
      keptOfficialLineups.push(fixture.id)
    }else if(!context.lineups_confirmed&&rows.some((r:any)=>r.source==='fotmob')&&!fotmobOfficial){
      // Predicted/provisional FotMob lineups are not retained in the table used by
      // model intelligence. They can be fetched again when they are close enough
      // to kickoff to be treated as an official XI candidate.
      lineupRowsToDelete.push(fixture.id)
    }

    details.push({
      fixtureId:fixture.id,kickoff:fixture.kickoff,status:fixture.status,
      refereeConfirmed,refereeLinked:Boolean(fixture.referee_id),
      lineupsFlag:Boolean(context.lineups_confirmed),homeStarters:homeAll,awayStarters:awayAll,
      manualComplete:completeManual,fotmobComplete:completeFotmob,fotmobImportedCloseToKickoff:closeEnough,
      validConfirmedLineup:validConfirmed,
    })
  }

  for(const batch of chunks([...new Set(refsToClear)])){
    const {error}=await supabase.from('fixtures').update({referee_id:null,updated_at:new Date().toISOString()}).in('id',batch)
    if(error) throw error
  }
  for(const fixtureId of [...new Set(lineupRowsToDelete)]){
    const {error}=await supabase.from('fixture_lineups').delete().eq('fixture_id',fixtureId).eq('source','fotmob')
    if(error) throw error
  }
  for(const batch of chunks([...new Set(lineupContextsToClear)])){
    const {error}=await supabase.from('manual_match_context').update({lineups_confirmed:false,updated_at:new Date().toISOString()}).in('fixture_id',batch)
    if(error) throw error
  }

  return new Response(JSON.stringify({
    ok:true,
    checked:fixtureRows.length,
    unconfirmedRefereeLinksCleared:new Set(refsToClear).size,
    falseLineupFlagsCleared:new Set(lineupContextsToClear).size,
    provisionalFotmobLineupsRemoved:new Set(lineupRowsToDelete).size,
    verifiedLineupsRetained:new Set(keptOfficialLineups).size,
    officialFotmobRule:'A FotMob XI is allowed into model intelligence only when it is a complete 11+11 set imported no more than 90 minutes before kickoff (or the match is live). Manual confirmed 11+11 XIs remain valid.',
    details,
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
