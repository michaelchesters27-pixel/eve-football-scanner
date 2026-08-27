import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '12 * * * *' }

function env(name:string){
  const value=process.env[name]
  if(!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const {data,error}=await supabase.rpc('settle_scanner_results')
  if(error){
    return new Response(JSON.stringify({ok:false,error:error.message,note:'PATCH_RESULTS_LOG_V1.sql must be installed before the new result settler can run.'}),{status:500,headers:{'content-type':'application/json'}})
  }
  return new Response(JSON.stringify({ok:true,settledOrRefreshed:Number(data??0),note:'EVE results are reconciled hourly from completed fixture data. Missing required stats stay pending rather than being counted as losses.'}),{headers:{'content-type':'application/json'}})
}
