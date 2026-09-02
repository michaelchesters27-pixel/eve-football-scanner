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
  const surface = String(process.env.EVE_PUBLICATION_SURFACE ?? 'all').trim().toLowerCase()
  const rpc = surface === 'core' || surface === 'best' || surface === 'best_bets'
    ? 'refresh_scanner_best_bets_cache'
    : surface === 'expanded' || surface === 'market' || surface === 'market_lab'
      ? 'refresh_scanner_market_lab_cache'
      : 'refresh_scanner_publication_cache'

  const { data, error } = await supabase.rpc(rpc)
  if (error) {
    return new Response(JSON.stringify({ ok: false, surface, rpc, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }

  return new Response(JSON.stringify({ ok: true, surface, publication: data }), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}
