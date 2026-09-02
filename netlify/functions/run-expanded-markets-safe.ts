import { createClient } from '@supabase/supabase-js'
import runExpanded from './run-expanded-markets'

const MODEL='v1-expanded-research'
function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}

export default async(request?:Request)=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),horizon=new Date(now.getTime()+7*86400000)
  const requestedFixtureId=request?new URL(request.url).searchParams.get('fixture_id'):null
  let query=supabase.from('fixtures').select('id').eq('status','scheduled').gte('kickoff',now.toISOString()).lt('kickoff',horizon.toISOString())
  if(requestedFixtureId) query=query.eq('id',requestedFixtureId)
  const {data:fixtures,error:fixtureError}=await query
  if(fixtureError) throw fixtureError
  const ids=(fixtures??[]).map((f:any)=>f.id)
  for(let i=0;i<ids.length;i+=100){
    const {error}=await supabase.from('predictions').update({publish_status:'suppressed',fair_probability:null}).eq('model_version',MODEL).in('fixture_id',ids.slice(i,i+100))
    if(error) throw error
  }

  const response=await runExpanded(request??new Request('https://eve.internal/run-expanded-markets'))
  const text=await response.text()
  let result:any=text
  try{result=JSON.parse(text)}catch{}
  if(!response.ok||result?.ok===false) throw new Error(`Expanded model failed: ${typeof result==='string'?result:JSON.stringify(result)}`)

  let staged=0
  for(let i=0;i<ids.length;i+=100){
    const {data,error}=await supabase.from('predictions').update({publish_status:'suppressed',fair_probability:null})
      .eq('model_version',MODEL).in('fixture_id',ids.slice(i,i+100)).select('id')
    if(error) throw error
    staged+=(data??[]).length
  }

  return new Response(JSON.stringify({ok:true,model:MODEL,fixtures:ids.length,generated:Number(result?.generated??0),staged,rawGeneratorResult:result,note:'Expanded predictions are staged as suppressed/un-calibrated. apply-expanded-calibration is the sole publisher of Market Lab selections.'}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
