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

  const { data, error } = await supabase
    .from('scanner_expanded_markets')
    .select('market,selection,homeTeam,awayTeam,confidence,dataQuality,fairProbability,fairOdds,bestBookmaker,bestOdds,edgePct,expectedValuePct,valueStatus')
    .order('confidence', { ascending: false })
    .limit(100)

  if (error) {
    return new Response(JSON.stringify({
      ok: false,
      patchRequired: true,
      error: error.message,
      message: 'Run supabase/PATCH_EXPANDED_VALUE_V1.sql once, then retry.',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  const rows = data ?? []
  const counts = rows.reduce((acc: Record<string, number>, row: any) => {
    const key = row.valueStatus ?? 'unknown'
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const priced = rows.filter((r: any) => r.bestOdds != null)
  const values = rows.filter((r: any) => r.valueStatus === 'value' || r.valueStatus === 'strong')

  return new Response(JSON.stringify({
    ok: true,
    expandedSignals: rows.length,
    pricedSignals: priced.length,
    valueCounts: counts,
    values: values.slice(0, 20),
    latestPriced: priced.slice(0, 20),
    rule: 'VALUE requires >=5pp probability edge and >=5% EV; STRONG VALUE requires >=7pp and >=10% EV.',
    note: 'NO VALUE means skip at the current bookmaker price. WAITING means no compatible recent price was available.',
  }), { headers: { 'content-type': 'application/json' } })
}
