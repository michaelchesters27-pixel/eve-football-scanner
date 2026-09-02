import { createClient } from '@supabase/supabase-js'
import syncFixtures from '../netlify/functions/sync-fotmob-fixtures'
import syncMatchday from '../netlify/functions/sync-matchday-context'
import syncSofascoreRefs from '../netlify/functions/sync-sofascore-referees'
import reconcileRefs from '../netlify/functions/reconcile-referees'
import runScanner from '../netlify/functions/run-scanner'
import runExpanded from '../netlify/functions/run-expanded-markets'
import refineRefs from '../netlify/functions/refine-referee-intelligence'
import applyCalibration from '../netlify/functions/apply-calibration'
import applyExpandedCalibration from '../netlify/functions/apply-expanded-calibration'
import runCombos from '../netlify/functions/run-combos'
import valueEngine from '../netlify/functions/value-engine'
import expandedValueEngine from '../netlify/functions/expanded-value-engine'
import refereeAudit from '../netlify/functions/referee-audit'
import { loadFixturePlayerHistory } from '../netlify/functions/_shared/player-history'
import { loadConfirmedStarterFormCache } from '../netlify/functions/_shared/player-form-cache'

function required(name:string){
  const value=process.env[name]
  if(!value) throw new Error(`Missing required GitHub Actions secret: ${name}`)
  return value
}

async function body(label:string, result:any){
  if(result instanceof Response){
    const text=await result.text()
    let parsed:any=text
    try{parsed=JSON.parse(text)}catch{}
    console.log(`\n=== ${label} ===`)
    console.log(JSON.stringify(parsed,null,2))
    if(!result.ok) throw new Error(`${label} failed HTTP ${result.status}`)
    return parsed
  }
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(result,null,2))
  return result
}

async function enrichConfirmedXIs(){
  const supabase=createClient(required('SUPABASE_URL'),required('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(), horizon=new Date(now.getTime()+4*86400000)
  const {data:fixtures,error}=await supabase.from('fixtures')
    .select('id,kickoff,status')
    .in('status',['scheduled','live'])
    .gte('kickoff',new Date(now.getTime()-3*3600000).toISOString())
    .lte('kickoff',horizon.toISOString())
    .order('kickoff',{ascending:true})
    .limit(120)
  if(error) throw error
  const ids=(fixtures??[]).map((x:any)=>x.id)
  if(!ids.length) return {checked:0,enriched:0,results:[]}
  const {data:contexts,error:contextError}=await supabase.from('manual_match_context')
    .select('fixture_id,lineups_confirmed')
    .in('fixture_id',ids)
    .eq('lineups_confirmed',true)
  if(contextError) throw contextError
  const results:any[]=[]
  for(const row of contexts??[]){
    try{
      const history=await loadFixturePlayerHistory(supabase,row.fixture_id,10)
      const form=await loadConfirmedStarterFormCache(supabase,row.fixture_id,10)
      results.push({fixtureId:row.fixture_id,history,form})
    }catch(error){results.push({fixtureId:row.fixture_id,error:error instanceof Error?error.message:String(error)})}
  }
  return {checked:(contexts??[]).length,enriched:results.filter((x)=>!x.error).length,results}
}

async function main(){
  required('SUPABASE_URL')
  required('SUPABASE_SERVICE_ROLE_KEY')
  console.log('EVE DIRECT FORCE SCAN START',new Date().toISOString())
  console.log('Runtime: GitHub Actions direct execution. Netlify is NOT used.')

  await body('1 FIXTURE REFRESH',await syncFixtures())
  await body('2 PRIMARY MATCH INTELLIGENCE',await syncMatchday())
  await body('3 SECOND-SOURCE REFEREE FALLBACK',await syncSofascoreRefs())
  await body('4 REFEREE RECONCILIATION',await reconcileRefs())
  await body('5 CONFIRMED XI PLAYER INTELLIGENCE',await enrichConfirmedXIs())
  await body('6 CORE BEST BETS REBUILD',await runScanner())
  await body('7 MARKET LAB REBUILD',await runExpanded(new Request('https://eve.direct/run-expanded-markets')))
  await body('8 FULL REFEREE INTELLIGENCE',await refineRefs())
  await body('9 CORE CALIBRATION',await applyCalibration())
  await body('10 EXPANDED CALIBRATION',await applyExpandedCalibration())

  if(process.env.ODDS_API_KEY){
    await body('11 CORE VALUE/PRICE REFRESH',await valueEngine())
    await body('12 EXPANDED VALUE/PRICE REFRESH',await expandedValueEngine())
  }else{
    console.log('\n=== 11-12 VALUE/PRICE REFRESH ===')
    console.log('SKIPPED: ODDS_API_KEY is not configured in GitHub Actions. Model bets still rebuild; bookmaker prices stay on their existing quota-controlled feed.')
  }

  await body('13 COMBO LAB REBUILD',await runCombos(new Request('https://eve.direct/run-combos')))
  const audit=await body('14 FINAL REFEREE AUDIT',await refereeAudit())
  const celtic=(audit?.fixtures??[]).filter((x:any)=>String(x.homeTeam??'').toLowerCase()==='celtic'&&String(x.awayTeam??'').toLowerCase().includes('aberdeen'))
  console.log('\n=== CELTIC V ABERDEEN ===')
  console.log(JSON.stringify(celtic,null,2))
  console.log('\nEVE DIRECT FORCE SCAN COMPLETE',new Date().toISOString())
}

main().catch((error)=>{
  console.error('\nEVE DIRECT FORCE SCAN FAILED')
  console.error(error instanceof Error?error.stack??error.message:String(error))
  process.exit(1)
})
