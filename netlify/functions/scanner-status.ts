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

  const now = new Date().toISOString()
  const [predictions, published, snapshots] = await Promise.all([
    supabase.from('predictions').select('id', { count: 'exact', head: true }).gte('generated_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
    supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('publish_status', 'published').gte('generated_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
    supabase.from('feature_snapshots').select('id', { count: 'exact', head: true }).gte('calculated_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()),
  ])

  const { data: latest, error } = await supabase
    .from('predictions')
    .select('generated_at,market,selection,confidence,grade,publish_status,fixtures!inner(kickoff)')
    .gte('fixtures.kickoff', now)
    .order('generated_at', { ascending: false })
    .limit(10)

  return new Response(JSON.stringify({
    ok: !error,
    recentGenerated: predictions.count ?? 0,
    recentPublished: published.count ?? 0,
    recentSnapshots: snapshots.count ?? 0,
    latest: latest ?? [],
    error: error?.message ?? null,
  }), { headers: { 'content-type': 'application/json' } })
}
