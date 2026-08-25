import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '10 5 * * *' }

function env(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}
function ymd(date: Date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth()+1).padStart(2,'0')}${String(date.getUTCDate()).padStart(2,'0')}`
}
async function fetchMatches(date: string) {
  const urls = [
    `https://www.fotmob.com/api/matches?date=${date}`,
    `https://www.fotmob.com/api/data/matches?date=${date}&timezone=Europe%2FLondon&ccode3=GBR`,
  ]
  let last = 'FotMob request failed'
  for (const url of urls) {
    try {
      const response = await fetch(url,{ headers:{ accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.3' } })
      if (!response.ok) { last = `${response.status} ${response.statusText}`; continue }
      const body = await response.json()
      if (Array.isArray(body?.leagues)) return body
    } catch (error) { last = error instanceof Error ? error.message : String(error) }
  }
  throw new Error(last)
}

export default async () => {
  const supabase = createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{ auth:{ persistSession:false,autoRefreshToken:false } })
  const now = new Date()
  let updated = 0
  const errors: string[] = []

  for (const offset of [-2,-1,0]) {
    const date = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+offset))
    try {
      const payload = await fetchMatches(ymd(date))
      for (const league of payload.leagues ?? []) {
        for (const match of league.matches ?? []) {
          const id = String(match?.id ?? '')
          if (!id) continue
          const finished = Boolean(match?.status?.finished)
          const cancelled = Boolean(match?.status?.cancelled)
          const started = Boolean(match?.status?.started)
          const status = cancelled ? 'cancelled' : finished ? 'finished' : started ? 'live' : 'scheduled'
          const patch: any = { status, updated_at:new Date().toISOString() }
          if (Number.isFinite(Number(match?.home?.score))) patch.home_goals = Number(match.home.score)
          if (Number.isFinite(Number(match?.away?.score))) patch.away_goals = Number(match.away.score)
          const { data,error } = await supabase.from('fixtures').update(patch).eq('source','fotmob').eq('source_fixture_id',id).select('id').maybeSingle()
          if (error) { errors.push(`${id}: ${error.message}`); continue }
          if (data?.id) updated += 1
        }
      }
    } catch (error) {
      errors.push(`${ymd(date)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return new Response(JSON.stringify({ ok:true, source:'fotmob', updated, errors }),{ headers:{ 'content-type':'application/json' } })
}
