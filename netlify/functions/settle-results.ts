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

  const { data: core, error: coreError } = await supabase.rpc('settle_v0_predictions')
  if (coreError) {
    return new Response(JSON.stringify({ ok: false, error: coreError.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  // Expansion SQL adds this RPC. Until that one-shot SQL has been run we keep
  // the proven v0 settlement working rather than failing the whole daily job.
  const { data: expanded, error: expandedError } = await supabase.rpc('settle_expanded_predictions')

  return new Response(JSON.stringify({
    ok: true,
    coreSettled: core ?? 0,
    expandedSettled: expandedError ? null : (expanded ?? 0),
    expansionReady: !expandedError,
    expansionMessage: expandedError ? expandedError.message : null,
  }), {
    headers: { 'content-type': 'application/json' },
  })
}
