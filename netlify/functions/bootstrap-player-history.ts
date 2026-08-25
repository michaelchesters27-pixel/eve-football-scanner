import { createClient } from '@supabase/supabase-js'
import { loadFixturePlayerHistory } from './_shared/player-history'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date().toISOString()
  const horizon=new Date(Date.now()+7*86400000).toISOString()
  const {data:fixtures,error}=await supabase.from('fixtures')
    .select('id,kickoff')
    .eq('source','fotmob')
    .eq('status','scheduled')
    .gte('kickoff',now).lt('kickoff',horizon)
    .order('kickoff',{ascending:true}).limit(4)
  if(error) throw error

  const results:any[]=[]
  for(const fixture of fixtures??[]){
    try{ results.push(await loadFixturePlayerHistory(supabase,fixture.id,6)) }
    catch(e){ results.push({fixtureId:fixture.id,error:e instanceof Error?e.message:String(e)}) }
  }
  const totals=results.reduce((a,r)=>({mappedMatches:a.mappedMatches+Number(r.mappedMatches??0),players:a.players+Number(r.players??0),stats:a.stats+Number(r.stats??0),lineups:a.lineups+Number(r.lineups??0)}),{mappedMatches:0,players:0,stats:0,lineups:0})
  await supabase.from('source_sync_runs').insert({source:'fotmob',job_name:'player-history-bootstrap',status:'success',rows_upserted:totals.stats,started_at:new Date().toISOString(),finished_at:new Date().toISOString(),error_message:JSON.stringify({fixtures:fixtures?.length??0,totals,results}).slice(0,5000)})
  return new Response(JSON.stringify({ok:true,fixtures:fixtures?.length??0,totals,results,note:'Bootstrap loads recent FotMob match details for the nearest upcoming teams and maps them onto existing finished EVE fixtures, avoiding duplicate team-history matches.'}),{headers:{'content-type':'application/json'}})
}
