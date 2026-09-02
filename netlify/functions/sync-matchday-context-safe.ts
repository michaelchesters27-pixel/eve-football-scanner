import syncMatchday from './sync-matchday-context-hardened'
import preModelSafety from './pre-model-safety'

async function parse(response:Response){
  const text=await response.text()
  try{return JSON.parse(text)}catch{return {text}}
}

export default async()=>{
  const importResponse=await syncMatchday()
  const imported=await parse(importResponse)
  if(!importResponse.ok||imported?.ok===false) throw new Error(`Match context import failed: ${JSON.stringify(imported)}`)

  // Defense in depth: the hardened importer refuses predicted/provisional XIs
  // before database insertion. This second gate independently re-checks stored
  // context before any model stage is allowed to run.
  const safetyResponse=await preModelSafety()
  const safety=await parse(safetyResponse)
  if(!safetyResponse.ok||safety?.ok===false) throw new Error(`Post-import context safety failed: ${JSON.stringify(safety)}`)

  return new Response(JSON.stringify({
    ok:true,imported,safety,
    note:'Primary ingestion rejects predicted/provisional XIs before insert, then the independent pre-model safety gate verifies the stored database state before models can run.',
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
