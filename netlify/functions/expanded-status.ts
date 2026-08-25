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

  const [{ count: generated, error: generatedError }, { count: published, error: publishedError }, { data: latest, error: latestError }] = await Promise.all([
    supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('model_version', 'v1-expanded-research').gte('generated_at', since),
    supabase.from('predictions').select('id', { count: 'exact', head: true }).eq('model_version', 'v1-expanded-research').eq('publish_status', 'published').gte('generated_at', since),
    supabase.from('predictions').select('generated_at,market,selection,confidence,publish_status').eq('model_version', 'v1-expanded-research').order('generated_at', { ascending: false }).limit(8),
  ])

  const error = generatedError ?? publishedError ?? latestError
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { 'content-type': 'application/json' } })

  return new Response(JSON.stringify({
    ok: true,
    generatedLast24h: generated ?? 0,
    publishedLast24h: published ?? 0,
    latest: latest ?? [],
    note: 'If generatedLast24h is increasing, the expanded-market background run is working.',
  }), { headers: { 'content-type': 'application/json' } })
}
