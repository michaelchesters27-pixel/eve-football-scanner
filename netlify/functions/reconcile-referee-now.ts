import { createClient } from '@supabase/supabase-js'
import { reconcileFixtureReferee } from './_shared/referee-reconcile'
import { refineFixtureRefereeIntelligence } from './refine-referee-intelligence'
import applyCoreCalibration from './apply-calibration'
import applyExpandedCalibration from './apply-expanded-calibration'

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}

export default async(request:Request)=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const url=new URL(request.url)
  let fixtureId=url.searchParams.get('fixture_id')
  if(!fixtureId){
    const now=new Date()
    const from=new Date(now.getTime()-180*60000).toISOString()
    const to=new Date(now.getTime()+6*3600000).toISOString()
    const {data:fixtures,error}=await supabase.from('fixtures').select('id,kickoff').in('status',['scheduled','live']).gte('kickoff',from).lte('kickoff',to).order('kickoff',{ascending:true}).limit(12)
    if(error) return new Response(JSON.stringify({ok:false,error:error.message}),{status:500,headers:{'content-type':'application/json'}})
    const ids=(fixtures??[]).map((f:any)=>f.id)
    if(ids.length){
      const {data:contexts}=await supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed').in('fixture_id',ids)
      const confirmed=new Set((contexts??[]).filter((c:any)=>c.referee_confirmed&&c.referee_name).map((c:any)=>c.fixture_id))
      fixtureId=(fixtures??[]).find((f:any)=>confirmed.has(f.id))?.id??null
    }
  }
  if(!fixtureId) return new Response(JSON.stringify({ok:true,matched:false,note:'No active fixture with a confirmed referee is currently available to reconcile.'}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
  try{
    const reconciliation=await reconcileFixtureReferee(supabase,fixtureId)
    const refinement=await refineFixtureRefereeIntelligence(supabase,fixtureId)
    const coreResponse=await applyCoreCalibration(),expandedResponse=await applyExpandedCalibration()
    const calibration={
      core:coreResponse.ok?await coreResponse.json():{ok:false,error:await coreResponse.text()},
      expanded:expandedResponse.ok?await expandedResponse.json():{ok:false,error:await expandedResponse.text()},
    }
    return new Response(JSON.stringify({ok:true,...reconciliation,refinement,calibration}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
  }catch(error){
    return new Response(JSON.stringify({ok:false,fixtureId,error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'content-type':'application/json','cache-control':'no-store'}})
  }
}
