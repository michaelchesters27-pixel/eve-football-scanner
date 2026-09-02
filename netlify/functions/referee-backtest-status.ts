import { createClient } from '@supabase/supabase-js'

const JOBS=['backtest-referee-v2-2526','backtest-referee-v2-match-cards-2526']
function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function parsed(row:any){let summary:any=null;if(row?.error_message){try{summary=JSON.parse(row.error_message)}catch{summary=row.error_message}}return{job:row?.job_name??null,run:row?{started_at:row.started_at,finished_at:row.finished_at,status:row.status,rows_upserted:row.rows_upserted}:null,summary}}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const {data,error}=await supabase.from('source_sync_runs').select('job_name,started_at,finished_at,status,rows_upserted,error_message').in('job_name',JOBS).order('started_at',{ascending:false}).limit(10)
  if(error) return new Response(JSON.stringify({ok:false,error:error.message}),{status:500,headers:{'content-type':'application/json'}})
  const latest=JOBS.map((job)=>parsed((data??[]).find((row:any)=>row.job_name===job)))
  return new Response(JSON.stringify({ok:true,tests:latest}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
