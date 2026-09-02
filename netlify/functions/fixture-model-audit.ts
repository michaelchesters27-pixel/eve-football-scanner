import { createClient } from '@supabase/supabase-js'

function env(name:string){const value=process.env[name];if(!value)throw new Error(`Missing required environment variable: ${name}`);return value}

export default async(request:Request)=>{
  const fixtureId=new URL(request.url).searchParams.get('fixture_id')
  if(!fixtureId)return new Response(JSON.stringify({ok:false,error:'fixture_id is required'}),{status:400,headers:{'content-type':'application/json'}})
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const [{data:fixture,error:fixtureError},{data:predictions,error:predictionError},{data:combo,error:comboError}]=await Promise.all([
    supabase.from('fixtures').select('id,kickoff,status,referee_id,updated_at').eq('id',fixtureId).maybeSingle(),
    supabase.from('predictions').select('id,model_version,market,selection,confidence,grade,data_quality,publish_status,fair_probability,generated_at,feature_snapshots(selection_key,calculated_at,features,evidence)').eq('fixture_id',fixtureId).in('model_version',['v0-research','v1-expanded-research']).order('generated_at',{ascending:false}),
    supabase.from('combo_recommendations').select('model_version,sample_size,data_quality,calculated_at').eq('fixture_id',fixtureId).order('calculated_at',{ascending:false}).limit(1).maybeSingle(),
  ])
  if(fixtureError||predictionError||comboError)return new Response(JSON.stringify({ok:false,error:fixtureError?.message??predictionError?.message??comboError?.message}),{status:500,headers:{'content-type':'application/json'}})
  const rows=(predictions??[]).map((p:any)=>({
    model:p.model_version,market:p.market,selection:p.selection,selectionKey:p.feature_snapshots?.selection_key??null,confidence:p.confidence,grade:p.grade,dataQuality:p.data_quality,publishStatus:p.publish_status,fairProbability:p.fair_probability,generatedAt:p.generated_at,snapshotCalculatedAt:p.feature_snapshots?.calculated_at??null,refereeRefined:Boolean(p.feature_snapshots?.features?.refereeIntelligence?.usable),refereeSample:p.feature_snapshots?.features?.refereeIntelligence?.sample??null,
  }))
  return new Response(JSON.stringify({ok:true,checkedAt:new Date().toISOString(),fixture,predictions:rows,combo:combo??null}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
