import { createClient } from '@supabase/supabase-js'
import systemHardAudit from './system-hard-audit'
import { auditResultIntegrity } from './_shared/result-integrity-audit'

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }

async function auditOddsEngines(supabase:any,nowMs:number){
  const jobs=['expanded-value-engine','value-engine']
  const {data,error}=await supabase
    .from('source_sync_runs')
    .select('job_name,status,started_at,finished_at,error_message')
    .in('job_name',jobs)
    .order('started_at',{ascending:false})
    .limit(30)
  if(error) throw error

  const latest=new Map<string,any>()
  for(const row of data??[]){
    if(!latest.has(row.job_name)) latest.set(row.job_name,row)
  }

  const hardViolations:any[]=[]
  const warnings:any[]=[]
  const summary:any={}
  const maxAgeMs=3*3600000

  for(const job of jobs){
    const row=latest.get(job)
    if(!row){
      hardViolations.push({type:'odds_engine_missing_run',job})
      summary[job]={status:'missing',ageHours:null}
      continue
    }
    const started=Date.parse(row.started_at)
    const ageHours=Number.isFinite(started)?Math.max(0,(nowMs-started)/3600000):null
    summary[job]={status:row.status,ageHours:ageHours==null?null:Number(ageHours.toFixed(2)),startedAt:row.started_at,finishedAt:row.finished_at}

    if(ageHours==null||nowMs-started>maxAgeMs){
      hardViolations.push({type:'odds_engine_stale_run',job,status:row.status,startedAt:row.started_at,ageHours})
      continue
    }
    if(row.status==='failed'){
      hardViolations.push({type:'odds_engine_failed',job,startedAt:row.started_at,error:row.error_message??null})
      continue
    }
    if(row.status==='partial'){
      warnings.push({type:'odds_engine_partial_provider_coverage',job,startedAt:row.started_at,detail:row.error_message??null})
    }
  }

  const {count:recentFailureCount,error:failureError}=await supabase
    .from('odds_price_failures')
    .select('*',{count:'exact',head:true})
    .gte('attempted_at',new Date(nowMs-24*3600000).toISOString())
  if(failureError) throw failureError
  summary.recentPriceFailureStates=recentFailureCount??0

  return {hardViolations,warnings,summary}
}

export default async()=>{
  const baseResponse=await systemHardAudit()
  const baseText=await baseResponse.text()
  let base:any={}
  try{ base=JSON.parse(baseText) }catch{ base={ok:false,auditPass:false,summary:{},hardViolations:[{type:'base_hard_audit_invalid_response',response:baseText.slice(0,500)}]} }

  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const nowMs=Date.now()
  const resultIntegrity=await auditResultIntegrity(supabase,nowMs)
  const oddsIntegrity=await auditOddsEngines(supabase,nowMs)

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

  const hardViolations=[...baseViolations,...resultIntegrity.hardViolations,...oddsIntegrity.hardViolations]
  const operationalWarnings=[...refereeDataWarnings,...oddsIntegrity.warnings]
  const auditPass=hardViolations.length===0

  return new Response(JSON.stringify({
    ...base,
    ok:auditPass,
    auditPass,
    summary:{
      ...(base?.summary??{}),
      resultIntegrity:resultIntegrity.summary,
      oddsIntegrity:oddsIntegrity.summary,
      refereeDataWarningCount:refereeDataWarnings.length,
      operationalWarningCount:operationalWarnings.length,
      hardViolationCount:hardViolations.length,
    },
    hardViolations,
    refereeDataWarnings,
    oddsWarnings:oddsIntegrity.warnings,
  }),{
    status:auditPass?200:500,
    headers:{'content-type':'application/json','cache-control':'no-store'},
  })
}
