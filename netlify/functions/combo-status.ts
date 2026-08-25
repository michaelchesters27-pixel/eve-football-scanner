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
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const [{ count, error: countError }, { data: latest, error: latestError }] = await Promise.all([
    supabase.from('combo_recommendations').select('id', { count: 'exact', head: true }).gte('calculated_at', since),
    supabase.from('combo_recommendations').select('fixture_id,sample_size,singles,doubles,treble,data_quality,calculated_at').order('calculated_at', { ascending: false }).limit(5),
  ])
  const error = countError ?? latestError
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'content-type': 'application/json' } })
  return new Response(JSON.stringify({ ok: true, combosLast24h: count ?? 0, latest: latest ?? [], note: 'Doubles and trebles are empirical joint frequencies from comparable historical home/away matches.' }), { headers: { 'content-type': 'application/json' } })
}
