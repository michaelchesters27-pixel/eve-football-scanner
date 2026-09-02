import { createClient } from '@supabase/supabase-js'
import runScanner from './run-scanner'

const MODEL='v0-research'
function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),horizon=new Date(now.getTime()+7*86400000)
  const {data:fixtures,error:fixtureError}=await supabase.from('fixtures').select('id').eq('status','scheduled').gte('kickoff',now.toISOString()).lt('kickoff',horizon.toISOString())
  if(fixtureError) throw fixtureError
  const ids=(fixtures??[]).map((f:any)=>f.id)
  for(let i=0;i<ids.length;i+=100){
    const {error}=await supabase.from('predictions').update({publish_status:'suppressed',fair_probability:null}).eq('model_version',MODEL).in('fixture_id',ids.slice(i,i+100))
    if(error) throw error
  }

  const response=await runScanner()
  const text=await response.text()
  let result:any=text
  try{result=JSON.parse(text)}catch{}
  if(!response.ok||result?.ok===false) throw new Error(`Core model failed: ${typeof result==='string'?result:JSON.stringify(result)}`)

  // The legacy model generator historically assigned a raw A/A+ publish flag.
  // Force every newly generated row back to staging. Calibration is the only
  // component allowed to publish an official Best Bet.
  let staged=0
  for(let i=0;i<ids.length;i+=100){
    const {data,error}=await supabase.from('predictions').update({publish_status:'suppressed',fair_probability:null})
      .eq('model_version',MODEL).in('fixture_id',ids.slice(i,i+100)).select('id')
    if(error) throw error
    staged+=(data??[]).length
  }

  return new Response(JSON.stringify({ok:true,model:MODEL,fixtures:ids.length,generated:Number(result?.generated??0),staged,rawGeneratorResult:result,note:'Core predictions are staged as suppressed/un-calibrated. apply-calibration is the sole publisher of Best Bets.'}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
