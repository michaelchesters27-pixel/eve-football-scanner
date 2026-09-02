import syncFixtures from './sync-fotmob-fixtures'
import syncMatchdayContext from './sync-matchday-context'
import syncSofascoreReferees from './sync-sofascore-referees'
import reconcileReferees from './reconcile-referees'
import runCoreScanner from './run-scanner'
import runExpandedMarkets from './run-expanded-markets'
import refineRefereeIntelligence from './refine-referee-intelligence'
import applyCoreCalibration from './apply-calibration'
import applyExpandedCalibration from './apply-expanded-calibration'
import runCombos from './run-combos'

// Browser-safe verification router. Scheduled Netlify functions return 403 when
// invoked directly; this endpoint lets an audit run one stage at a time without
// changing the real schedules.
export default async(request:Request)=>{
  const stage=new URL(request.url).searchParams.get('stage')??''
  try{
    if(stage==='fixtures')return syncFixtures()
    if(stage==='context')return syncMatchdayContext(request)
    if(stage==='referee-fallback')return syncSofascoreReferees()
    if(stage==='reconcile')return reconcileReferees()
    if(stage==='core')return runCoreScanner(request)
    if(stage==='expanded')return runExpandedMarkets(request)
    if(stage==='refine')return refineRefereeIntelligence(request)
    if(stage==='calibration'){
      const core=await applyCoreCalibration()
      const expanded=await applyExpandedCalibration()
      return new Response(JSON.stringify({ok:core.ok&&expanded.ok,core:core.ok?await core.json():{ok:false,error:await core.text()},expanded:expanded.ok?await expanded.json():{ok:false,error:await expanded.text()}}),{status:core.ok&&expanded.ok?200:500,headers:{'content-type':'application/json','cache-control':'no-store'}})
    }
    if(stage==='combos')return runCombos(request)
    return new Response(JSON.stringify({ok:false,error:'Unknown stage',allowed:['fixtures','context','referee-fallback','reconcile','core','expanded','refine','calibration','combos']}),{status:400,headers:{'content-type':'application/json','cache-control':'no-store'}})
  }catch(error){
    return new Response(JSON.stringify({ok:false,stage,error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'content-type':'application/json','cache-control':'no-store'}})
  }
}
