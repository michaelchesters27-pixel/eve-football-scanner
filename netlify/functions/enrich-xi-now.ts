import { createClient } from '@supabase/supabase-js'
import syncMatchdayContext from './sync-matchday-context'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }
function json(data:any,status=200){ return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}}) }

export default async(request:Request)=>{
  try{
    const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
    const url=new URL(request.url)
    let fixtureId=url.searchParams.get('fixture_id')
    if(!fixtureId){
      const {data:contexts,error}=await supabase.from('manual_match_context')
        .select('fixture_id,confirmed_at,fixtures!inner(kickoff,status)')
        .eq('lineups_confirmed',true)
        .in('fixtures.status',['scheduled','live'])
        .order('confirmed_at',{ascending:false})
        .limit(1)
      if(error) throw error
      fixtureId=contexts?.[0]?.fixture_id??null
    }
    if(!fixtureId) return json({ok:false,error:'No active fixture with confirmed starting XIs was found.'},404)

    const matchdayUrl=new URL(url.toString())
    matchdayUrl.search=`?fixture_id=${encodeURIComponent(fixtureId)}`
    let matchday:any=null
    try{
      const matchdayResponse=await syncMatchdayContext(new Request(matchdayUrl.toString()))
      matchday=await matchdayResponse.json()
    }catch(error){
      matchday={ok:false,error:error instanceof Error?error.message:String(error)}
    }

    const target=new URL('/.netlify/functions/enrich-lineup-history-background',url.origin)
    target.searchParams.set('fixture_id',fixtureId)
    const response=await fetch(target.toString(),{method:'GET'})
    if(!response.ok&&response.status!==202) return json({ok:false,fixtureId,matchday,error:`Background enrichment returned ${response.status}`},502)
    return json({
      ok:true,
      fixtureId,
      started:true,
      matchday,
      note:'Match-day context was refreshed first, including referee-history reconciliation. Targeted XI enrichment is now rebuilding up to 10 recent appearances per confirmed starter with the corrected booking parser, then EVE reruns expanded markets and combos.',
    })
  }catch(error){ return json({ok:false,error:error instanceof Error?error.message:String(error)},500) }
}
