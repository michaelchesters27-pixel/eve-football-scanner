import { createClient } from '@supabase/supabase-js'

const JOB='backtest-referee-v2-2526'
function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const {data,error}=await supabase.from('source_sync_runs').select('started_at,finished_at,status,rows_upserted,error_message').eq('job_name',JOB).order('started_at',{ascending:false}).limit(1).maybeSingle()
  if(error) return new Response(JSON.stringify({ok:false,error:error.message}),{status:500,headers:{'content-type':'application/json'}})
  let summary:any=null
  if(data?.error_message){try{summary=JSON.parse(data.error_message)}catch{summary=data.error_message}}
  return new Response(JSON.stringify({ok:true,job:JOB,run:data??null,summary}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
