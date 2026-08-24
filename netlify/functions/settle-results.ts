import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '25 5 * * *' }

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase.rpc('settle_v0_predictions')
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ ok: true, settled: data ?? 0 }), {
    headers: { 'content-type': 'application/json' },
  })
}
