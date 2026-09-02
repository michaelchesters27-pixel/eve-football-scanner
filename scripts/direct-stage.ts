import syncFixtures from '../netlify/functions/sync-fotmob-fixtures'
import syncMatchday from '../netlify/functions/sync-matchday-context'
import canonicalizeFotmobRefs from '../netlify/functions/canonicalize-fotmob-referees'
import syncSofascoreRefs from '../netlify/functions/sync-sofascore-referees'
import reconcileRefs from '../netlify/functions/reconcile-referees-uncapped'
import preModelSafety from '../netlify/functions/pre-model-safety'
import runScanner from '../netlify/functions/run-scanner'
import runExpanded from '../netlify/functions/run-expanded-markets'
import refineRefs from '../netlify/functions/refine-referee-intelligence-uncapped'
import applyCalibration from '../netlify/functions/apply-calibration'
import applyExpandedCalibration from '../netlify/functions/apply-expanded-calibration'
import runCombos from '../netlify/functions/run-combos'
import syncResults from '../netlify/functions/sync-fotmob-results'
import settleResults from '../netlify/functions/settle-results'
import systemHardAudit from '../netlify/functions/system-hard-audit'

function required(name:string){
  const value=process.env[name]
  if(!value) throw new Error(`Missing required GitHub Actions secret: ${name}`)
  return value
}

async function unwrap(label:string,result:any){
  if(result instanceof Response){
    const text=await result.text()
    let parsed:any=text
    try{parsed=JSON.parse(text)}catch{}
    console.log(`\n=== ${label} ===`)
    console.log(JSON.stringify(parsed,null,2))
    if(!result.ok) throw new Error(`${label} failed HTTP ${result.status}: ${typeof parsed==='string'?parsed:JSON.stringify(parsed)}`)
    if(parsed&&typeof parsed==='object'&&parsed.ok===false) throw new Error(`${label} reported ok=false: ${JSON.stringify(parsed)}`)
    return parsed
  }
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(result,null,2))
  return result
}

function failOnReportedErrors(label:string,parsed:any){
  const errorCount=Array.isArray(parsed?.errors)?parsed.errors.length:Number(parsed?.errors??0)
  if(Number.isFinite(errorCount)&&errorCount>0) throw new Error(`${label} completed with ${errorCount} reported error(s)`)
}

async function main(){
  required('SUPABASE_URL')
  required('SUPABASE_SERVICE_ROLE_KEY')
  const stage=String(process.env.EVE_STAGE??'').trim().toLowerCase()
  console.log(`EVE DIRECT STAGE START: ${stage}`,new Date().toISOString())

  if(stage==='fixtures') await unwrap('FIXTURE REFRESH',await syncFixtures())
  else if(stage==='match-intel'){
    const parsed=await unwrap('PRIMARY MATCH INTELLIGENCE',await syncMatchday())
    failOnReportedErrors('PRIMARY MATCH INTELLIGENCE',parsed)
  }
  else if(stage==='canonical-ref'){
    const parsed=await unwrap('EXACT FOTMOB REFEREE CANONICALIZATION',await canonicalizeFotmobRefs())
    failOnReportedErrors('EXACT FOTMOB REFEREE CANONICALIZATION',parsed)
  }
  else if(stage==='ref-fallback') await unwrap('SECOND-SOURCE REFEREE FALLBACK',await syncSofascoreRefs())
  else if(stage==='ref-reconcile'){
    const parsed=await unwrap('UNCAPPED CONFIRMED-REFEREE RECONCILIATION',await reconcileRefs())
    failOnReportedErrors('UNCAPPED CONFIRMED-REFEREE RECONCILIATION',parsed)
  }
  else if(stage==='safety') await unwrap('PRE-MODEL SAFETY GATE',await preModelSafety())
  else if(stage==='core') await unwrap('CORE BEST BETS REBUILD',await runScanner())
  else if(stage==='expanded') await unwrap('MARKET LAB REBUILD',await runExpanded(new Request('https://eve.github/run-expanded-markets')))
  else if(stage==='refine-ref'){
    const parsed=await unwrap('UNCAPPED CONFIRMED REFEREE INTELLIGENCE',await refineRefs())
    failOnReportedErrors('UNCAPPED CONFIRMED REFEREE INTELLIGENCE',parsed)
  }
  else if(stage==='cal-core') await unwrap('CORE CALIBRATION',await applyCalibration())
  else if(stage==='cal-expanded') await unwrap('EXPANDED CALIBRATION',await applyExpandedCalibration())
  else if(stage==='combos') await unwrap('COMBO LAB REBUILD',await runCombos(new Request('https://eve.github/run-combos')))
  else if(stage==='results'){
    const sync=await unwrap('FOTMOB RESULT REFRESH',await syncResults())
    failOnReportedErrors('FOTMOB RESULT REFRESH',sync)
    await unwrap('RESULT SETTLEMENT',await settleResults())
  }
  else if(stage==='audit') await unwrap('SYSTEM HARD AUDIT',await systemHardAudit())
  else throw new Error(`Unknown EVE_STAGE: ${stage}`)

  console.log(`EVE DIRECT STAGE COMPLETE: ${stage}`,new Date().toISOString())
}

main().catch((error)=>{
  console.error(`EVE DIRECT STAGE FAILED: ${process.env.EVE_STAGE??''}`)
  console.error(error instanceof Error?error.stack??error.message:String(error))
  process.exit(1)
})
