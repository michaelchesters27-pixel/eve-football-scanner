import { createClient } from '@supabase/supabase-js'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const [{count:players,error:pErr},{count:stats,error:sErr},{count:lineups,error:lErr},{data:runs}]=await Promise.all([
    supabase.from('players').select('id',{count:'exact',head:true}),
    supabase.from('player_match_stats').select('id',{count:'exact',head:true}),
    supabase.from('fixture_lineups').select('id',{count:'exact',head:true}),
    supabase.from('source_sync_runs').select('job_name,status,rows_upserted,finished_at,error_message').in('job_name',['player-history-bootstrap','lineup-history-enrichment']).order('finished_at',{ascending:false}).limit(3),
  ])
  const error=pErr?.message??sErr?.message??lErr?.message
  if(error) return new Response(JSON.stringify({ok:false,error}),{status:500,headers:{'content-type':'application/json'}})
  const latestLoads=(runs??[]).map((r:any)=>{
    let details:any=r.error_message
    try{ details=r.error_message?JSON.parse(r.error_message):null }catch{}
    return {job:r.job_name,status:r.status,rows:r.rows_upserted,finishedAt:r.finished_at,details}
  })
  return new Response(JSON.stringify({
    ok:true,
    players:players??0,
    playerMatchStats:stats??0,
    storedLineupRows:lineups??0,
    latestLoads,
    readyForXiIntelligence:(stats??0)>0,
    note:'The bootstrap maps FotMob recent-match details onto EVE’s existing finished fixtures, so player history is added without duplicating the team-history database. A confirmed XI then requests up to 10 prior matches for that exact fixture.'
  }),{headers:{'content-type':'application/json'}})
}
