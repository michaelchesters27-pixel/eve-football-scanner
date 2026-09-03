import { createClient } from '@supabase/supabase-js'
import systemHardAudit from './system-hard-audit'
import { auditResultIntegrity } from './_shared/result-integrity-audit'

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }

export default async()=>{
  const baseResponse=await systemHardAudit()
  const baseText=await baseResponse.text()
  let base:any={}
  try{ base=JSON.parse(baseText) }catch{ base={ok:false,auditPass:false,summary:{},hardViolations:[{type:'base_hard_audit_invalid_response',response:baseText.slice(0,500)}]} }

  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const resultIntegrity=await auditResultIntegrity(supabase,Date.now())

  // The V1 audit checked only literal "pending" Best Bets. The integrity audit
  // supersedes that narrow rule with finished pending + awaiting_data checks for
  // Best Bets, Market Lab and Combo Lab, so remove the duplicate V1 finding.
  const baseViolations=(Array.isArray(base?.hardViolations)?base.hardViolations:[])
    .filter((row:any)=>row?.type!=='finished_best_bet_still_pending')
  const hardViolations=[...baseViolations,...resultIntegrity.hardViolations]
  const auditPass=hardViolations.length===0

  return new Response(JSON.stringify({
    ...base,
    ok:auditPass,
    auditPass,
    summary:{
      ...(base?.summary??{}),
      resultIntegrity:resultIntegrity.summary,
      hardViolationCount:hardViolations.length,
    },
    hardViolations,
  }),{
    status:auditPass?200:500,
    headers:{'content-type':'application/json','cache-control':'no-store'},
  })
}
