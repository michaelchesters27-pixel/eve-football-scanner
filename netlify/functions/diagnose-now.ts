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

  const now = new Date()
  const d7 = new Date(now.getTime() + 7 * 86400000).toISOString()
  const d14 = new Date(now.getTime() + 14 * 86400000).toISOString()
  const d30 = new Date(now.getTime() + 30 * 86400000).toISOString()

  const [all, scheduled, next7, next14, next30, upcoming, syncRuns] = await Promise.all([
    supabase.from('fixtures').select('*', { count: 'exact', head: true }),
    supabase.from('fixtures').select('*', { count: 'exact', head: true }).eq('status', 'scheduled'),
    supabase.from('fixtures').select('*', { count: 'exact', head: true }).eq('status', 'scheduled').gte('kickoff', now.toISOString()).lt('kickoff', d7),
    supabase.from('fixtures').select('*', { count: 'exact', head: true }).eq('status', 'scheduled').gte('kickoff', now.toISOString()).lt('kickoff', d14),
    supabase.from('fixtures').select('*', { count: 'exact', head: true }).eq('status', 'scheduled').gte('kickoff', now.toISOString()).lt('kickoff', d30),
    supabase.from('fixtures').select('id,kickoff,status,source_fixture_id,home_team_id,away_team_id').eq('status', 'scheduled').gte('kickoff', now.toISOString()).order('kickoff').limit(20),
    supabase.from('source_sync_runs').select('job_name,status,rows_upserted,error_message,started_at,finished_at').order('started_at', { ascending: false }).limit(5),
  ])

  const errors = [all.error, scheduled.error, next7.error, next14.error, next30.error, upcoming.error, syncRuns.error].filter(Boolean)
  if (errors.length) {
    return new Response(JSON.stringify({ ok: false, errors: errors.map((e) => e?.message) }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({
    ok: true,
    now: now.toISOString(),
    counts: {
      allFixtures: all.count ?? 0,
      scheduledAll: scheduled.count ?? 0,
      scheduledNext7Days: next7.count ?? 0,
      scheduledNext14Days: next14.count ?? 0,
      scheduledNext30Days: next30.count ?? 0,
    },
    upcoming: upcoming.data ?? [],
    syncRuns: syncRuns.data ?? [],
  }), {
    headers: { 'content-type': 'application/json' },
  })
}
