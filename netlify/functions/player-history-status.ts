import { createClient } from '@supabase/supabase-js'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const [{count:players,error:pErr},{count:stats,error:sErr},{count:lineups,error:lErr}]=await Promise.all([
    supabase.from('players').select('id',{count:'exact',head:true}),
    supabase.from('player_match_stats').select('id',{count:'exact',head:true}),
    supabase.from('fixture_lineups').select('id',{count:'exact',head:true}),
  ])
  const error=pErr?.message??sErr?.message??lErr?.message
  if(error) return new Response(JSON.stringify({ok:false,error}),{status:500,headers:{'content-type':'application/json'}})
  return new Response(JSON.stringify({
    ok:true,
    players:players??0,
    playerMatchStats:stats??0,
    storedLineupRows:lineups??0,
    note:'Player history grows automatically from completed FotMob matches. Confirming a full starting XI also launches a targeted load of up to the previous 10 matches for each team before EVE re-runs that fixture.'
  }),{headers:{'content-type':'application/json'}})
}
