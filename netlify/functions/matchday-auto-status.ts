import { createClient } from '@supabase/supabase-js'

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date()
  const horizon=new Date(now.getTime()+4*86400000).toISOString()
  const [{data:latestRun,error:runError},{data:fixtures,error:fixtureError}]=await Promise.all([
    supabase.from('source_sync_runs').select('started_at,finished_at,status,rows_upserted,error_message').eq('job_name','matchday-auto-sync').order('started_at',{ascending:false}).limit(1).maybeSingle(),
    supabase.from('fixture_setup_board').select('fixtureId,homeTeam,awayTeam,kickoff,referee,refereeConfirmed,lineupsConfirmed,homeStarters,awayStarters').gte('kickoff',now.toISOString()).lte('kickoff',horizon).order('kickoff',{ascending:true}).limit(80),
  ])
  const error=runError??fixtureError
  if(error) return new Response(JSON.stringify({ok:false,error:error.message}),{status:500,headers:{'content-type':'application/json'}})
  const rows=fixtures??[]
  return new Response(JSON.stringify({
    ok:true,
    nextFourDays:rows.length,
    refereeConfirmed:rows.filter((x:any)=>x.refereeConfirmed).length,
    lineupsConfirmed:rows.filter((x:any)=>x.lineupsConfirmed).length,
    awaitingLineups:rows.filter((x:any)=>!x.lineupsConfirmed).length,
    latestRun:latestRun??null,
    fixtures:rows.slice(0,30),
    policy:'Every 15 minutes, EVE checks FotMob match details for fixtures inside roughly 2 hours 15 minutes of kickoff. It imports the referee and official 11+11 starting XIs when available and then triggers re-analysis.',
  }),{headers:{'content-type':'application/json'}})
}
