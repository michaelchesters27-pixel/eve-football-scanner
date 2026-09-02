import { createClient } from '@supabase/supabase-js'
import { refineFixtureRefereeIntelligence } from './refine-referee-intelligence'
import applyCoreCalibration from './apply-calibration'
import applyExpandedCalibration from './apply-expanded-calibration'

const LOOKBACK_MS=3*60*60*1000
const LOOKAHEAD_MS=7*24*60*60*1000

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function chunks<T>(items:T[],size=100){const out:T[][]=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out}
async function json(response:Response){const text=await response.text();try{return JSON.parse(text)}catch{return {ok:response.ok,text}}}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),from=new Date(now.getTime()-LOOKBACK_MS),to=new Date(now.getTime()+LOOKAHEAD_MS)
  const {data:fixtures,error:fixtureError}=await supabase.from('fixtures')
    .select('id,kickoff,referee_id')
    .in('status',['scheduled','live'])
    .gte('kickoff',from.toISOString())
    .lte('kickoff',to.toISOString())
    .order('kickoff',{ascending:true})
  if(fixtureError) throw fixtureError
  const fixtureRows=fixtures??[]
  const ids=fixtureRows.map((f:any)=>f.id)
  const contexts:any[]=[]
  for(const batch of chunks(ids)){
    const {data,error}=await supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed').in('fixture_id',batch)
    if(error) throw error
    contexts.push(...(data??[]))
  }
  const confirmed=new Set(contexts.filter((c:any)=>c.referee_confirmed&&String(c.referee_name??'').trim()).map((c:any)=>c.fixture_id))
  const targets=fixtureRows.filter((f:any)=>confirmed.has(f.id))
  const results:any[]=[]
  let refined=0
  for(const fixture of targets as any[]){
    try{
      const result=await refineFixtureRefereeIntelligence(supabase,fixture.id)
      results.push(result)
      refined+=Number(result.refined??0)
    }catch(error){results.push({fixtureId:fixture.id,refined:0,error:error instanceof Error?error.message:String(error)})}
  }
  const coreResponse=await applyCoreCalibration()
  const expandedResponse=await applyExpandedCalibration()
  const core=await json(coreResponse),expanded=await json(expandedResponse)
  if(!coreResponse.ok||core?.ok===false) throw new Error(`Core calibration failed after referee refinement: ${JSON.stringify(core)}`)
  if(!expandedResponse.ok||expanded?.ok===false) throw new Error(`Expanded calibration failed after referee refinement: ${JSON.stringify(expanded)}`)
  return new Response(JSON.stringify({
    ok:true,checked:targets.length,refined,
    errors:results.filter((r)=>r.error).length,
    noProcessingCap:true,lookaheadDays:7,
    calibration:{core,expanded},results,
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
