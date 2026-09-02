import { createClient } from '@supabase/supabase-js'
import { reconcileActiveReferees } from './_shared/referee-reconcile'
import { refineFixtureRefereeIntelligence } from './refine-referee-intelligence'

// Run shortly after the hourly match-context scan. This is deliberately hourly:
// the scanner only needs another model refresh when the linked referee/profile
// actually changes.
export const config={schedule:'10 * * * *'}

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const result=await reconcileActiveReferees(supabase)
  const refreshed:any[]=[]
  for(const row of result.results??[]){
    const newProfile=Boolean(row?.direct?.hydrated&&!row?.direct?.cached)
    if(!row?.fixtureId||(!row?.changed&&!newProfile)) continue
    try{refreshed.push(await refineFixtureRefereeIntelligence(supabase,row.fixtureId))}
    catch(error){refreshed.push({fixtureId:row.fixtureId,error:error instanceof Error?error.message:String(error)})}
  }
  return new Response(JSON.stringify({
    ok:true,...result,refreshed,
    note:'Every hour, confirmed referee names are reconciled conservatively. When the linked referee or referee profile changes, EVE immediately refreshes full referee intelligence in live card predictions.',
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
