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

  const fixtureEvidence=new Map(
    (Array.isArray(base?.fixtures)?base.fixtures:[]).map((row:any)=>[row?.fixtureId,row])
  )
  const refereeDataWarnings:any[]=[]

  // The V1 audit checked only literal "pending" Best Bets. The integrity audit
  // supersedes that narrow rule with finished pending + awaiting_data checks for
  // Best Bets, Market Lab and Combo Lab, so remove the duplicate V1 finding.
  //
  // A confirmed referee whose exact canonical FotMob identity is known can also
  // legitimately have no usable historical profile available from the provider.
  // That is safe only when EVE has applied zero referee influence to the card
  // snapshots. Preserve it as a visible warning rather than failing publication.
  // Any identity problem or any referee influence without a usable profile stays
  // a hard violation.
  const baseViolations=(Array.isArray(base?.hardViolations)?base.hardViolations:[])
    .filter((row:any)=>{
      if(row?.type==='finished_best_bet_still_pending') return false
      if(row?.type!=='confirmed_referee_missing_usable_profile') return true

      const evidence:any=fixtureEvidence.get(row?.fixtureId)
      const exactCanonicalIdentity=/^fotmob-referee:\d+$/.test(String(evidence?.sourceKey??''))
      const noUsableProfile=Number(evidence?.profileSample??0)<3
      const noRefereeInfluence=Number(evidence?.refereeRefined??0)===0

      if(exactCanonicalIdentity&&noUsableProfile&&noRefereeInfluence){
        refereeDataWarnings.push({
          ...row,
          type:'confirmed_referee_profile_unavailable_safe_fallback',
          sourceKey:evidence?.sourceKey??null,
          profileSample:Number(evidence?.profileSample??0),
          cardSnapshots:Number(evidence?.cardSnapshots??0),
          refereeRefined:Number(evidence?.refereeRefined??0),
          safety:'Exact referee identity confirmed; no usable profile available; referee influence remained disabled.',
        })
        return false
      }
      return true
    })

  const hardViolations=[...baseViolations,...resultIntegrity.hardViolations]
  const auditPass=hardViolations.length===0

  return new Response(JSON.stringify({
    ...base,
    ok:auditPass,
    auditPass,
    summary:{
      ...(base?.summary??{}),
      resultIntegrity:resultIntegrity.summary,
      refereeDataWarningCount:refereeDataWarnings.length,
      hardViolationCount:hardViolations.length,
    },
    hardViolations,
    refereeDataWarnings,
  }),{
    status:auditPass?200:500,
    headers:{'content-type':'application/json','cache-control':'no-store'},
  })
}
