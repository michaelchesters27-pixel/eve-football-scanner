import { createClient } from '@supabase/supabase-js'

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await supabase.rpc('refresh_scanner_publication_cache')
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  return new Response(JSON.stringify(data ?? { ok: true }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
