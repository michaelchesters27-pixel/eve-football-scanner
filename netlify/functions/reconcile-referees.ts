import { createClient } from '@supabase/supabase-js'
import { reconcileActiveReferees } from './_shared/referee-reconcile'

export const config={schedule:'*/15 * * * *'}

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const result=await reconcileActiveReferees(supabase)
  return new Response(JSON.stringify({ok:true,...result,note:'Confirmed referee names are reconciled to existing historical referee identities only when the name match is strong and the historical sample has at least 3 matches.'}),{headers:{'content-type':'application/json'}})
}
