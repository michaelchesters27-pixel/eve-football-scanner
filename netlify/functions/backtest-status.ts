import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: ws as any },
  })
  const { data, error } = await supabase
    .from('source_sync_runs')
    .select('id,started_at,finished_at,status,rows_upserted,error_message')
    .eq('source', 'eve-backtest')
    .eq('job_name', 'backtest-2526-v0')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return new Response(JSON.stringify({ ok:false, error:error.message }), { status:500, headers:{ 'content-type':'application/json' } })
  if (!data) return new Response(JSON.stringify({ ok:true, status:'not_started' }), { headers:{ 'content-type':'application/json' } })
  let results: unknown = null
  if (data.status === 'success' && data.error_message) {
    try { results = JSON.parse(data.error_message) } catch { results = data.error_message }
  }
  return new Response(JSON.stringify({ ok:data.status !== 'failed', run:{ id:data.id, startedAt:data.started_at, finishedAt:data.finished_at, status:data.status, evaluated:data.rows_upserted }, results, error:data.status === 'failed' ? data.error_message : null }), { headers:{ 'content-type':'application/json' } })
}
