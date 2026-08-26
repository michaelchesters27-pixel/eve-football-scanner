import { createClient } from '@supabase/supabase-js'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const [{count:players,error:pErr},{count:stats,error:sErr},{count:lineups,error:lErr},{data:runs}]=await Promise.all([
    supabase.from('players').select('id',{count:'exact',head:true}),
    supabase.from('player_match_stats').select('id',{count:'exact',head:true}),
    supabase.from('fixture_lineups').select('id',{count:'exact',head:true}),
    supabase.from('source_sync_runs').select('job_name,status,rows_upserted,finished_at,error_message').in('job_name',['player-history-bootstrap','lineup-history-enrichment']).order('finished_at',{ascending:false}).limit(5),
  ])
  const error=pErr?.message??sErr?.message??lErr?.message
  if(error) return new Response(JSON.stringify({ok:false,error}),{status:500,headers:{'content-type':'application/json'}})

  const cacheQuery=await supabase.from('fixture_player_form_cache').select('fixture_id,player_id,matches_sample,refreshed_at')
  const cacheReady=!cacheQuery.error
  const cacheRows=cacheReady?(cacheQuery.data??[]):[]
  const latestLoads=(runs??[]).map((r:any)=>{
    let details:any=r.error_message
    try{ details=r.error_message?JSON.parse(r.error_message):null }catch{}
    return {job:r.job_name,status:r.status,rows:r.rows_upserted,finishedAt:r.finished_at,details}
  })
  const samples=cacheRows.map((r:any)=>Number(r.matches_sample??0))
  return new Response(JSON.stringify({
    ok:true,
    players:players??0,
    playerMatchStats:stats??0,
    storedLineupRows:lineups??0,
    playerFormCache:{
      setupReady:cacheReady,
      rows:cacheRows.length,
      playersWith5:samples.filter((n:number)=>n>=5).length,
      playersWith8:samples.filter((n:number)=>n>=8).length,
      playersWith10:samples.filter((n:number)=>n>=10).length,
      averageSample:samples.length?Math.round(samples.reduce((a:number,b:number)=>a+b,0)/samples.length*10)/10:0,
      patchRequired:!cacheReady,
    },
    latestLoads,
    readyForXiIntelligence:(stats??0)>0||samples.some((n:number)=>n>=5),
    note:cacheReady
      ? 'Confirmed XIs now use the deeper of EVE-mapped match history or the targeted FotMob player-form cache. Fewer than 5 appearances is shown as thin evidence and cannot supply player averages to the XI model.'
      : 'Run PATCH_PLAYER_FORM_CACHE_V1.sql to enable targeted 5-10 appearance XI enrichment.',
  }),{headers:{'content-type':'application/json'}})
}
