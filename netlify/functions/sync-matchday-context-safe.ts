import syncMatchday from './sync-matchday-context'
import preModelSafety from './pre-model-safety'

async function parse(response:Response){
  const text=await response.text()
  try{return JSON.parse(text)}catch{return {text}}
}

export default async()=>{
  const importResponse=await syncMatchday()
  const imported=await parse(importResponse)
  if(!importResponse.ok||imported?.ok===false) throw new Error(`Match context import failed: ${JSON.stringify(imported)}`)

  // The upstream FotMob payload may contain predicted/provisional XIs in the
  // same 11+11 shape as actual lineups. Never leave those rows available to a
  // model after ingestion: validate source evidence and fail closed immediately.
  const safetyResponse=await preModelSafety()
  const safety=await parse(safetyResponse)
  if(!safetyResponse.ok||safety?.ok===false) throw new Error(`Post-import context safety failed: ${JSON.stringify(safety)}`)

  return new Response(JSON.stringify({ok:true,imported,safety,note:'Every match-context import is followed immediately by the official-XI/referee safety gate before the stage can succeed.'}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
