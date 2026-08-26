import { createClient } from '@supabase/supabase-js'

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

    const target=new URL('/.netlify/functions/enrich-lineup-history-background',url.origin)
    target.searchParams.set('fixture_id',fixtureId)
    const response=await fetch(target.toString(),{method:'GET'})
    if(!response.ok&&response.status!==202) return json({ok:false,fixtureId,error:`Background enrichment returned ${response.status}`},502)
    return json({
      ok:true,
      fixtureId,
      started:true,
      note:'Targeted XI enrichment started. EVE will seek up to 10 recent appearances for each confirmed FotMob starter, cache the usable form, then rerun expanded markets and combos. Refresh Match Setup after a few minutes.',
    })
  }catch(error){ return json({ok:false,error:error instanceof Error?error.message:String(error)},500) }
}
