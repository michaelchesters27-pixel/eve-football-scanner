import applyCoreCalibration from './apply-calibration'
import applyExpandedCalibration from './apply-expanded-calibration'

export const config={schedule:'45 * * * *'}

export default async()=>{
  const [core,expanded]=await Promise.all([applyCoreCalibration(),applyExpandedCalibration()])
  const coreBody=await core.json().catch(async()=>({ok:false,error:await core.text()}))
  const expandedBody=await expanded.json().catch(async()=>({ok:false,error:await expanded.text()}))
  const ok=core.ok&&expanded.ok
  return new Response(JSON.stringify({ok,core:coreBody,expanded:expandedBody,note:'Hourly calibration safety pass after core, expanded and referee intelligence refreshes.'}),{status:ok?200:500,headers:{'content-type':'application/json','cache-control':'no-store'}})
}
