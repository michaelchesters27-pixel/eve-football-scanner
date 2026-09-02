import { createClient } from '@supabase/supabase-js'
import { buildRefereeIntelligence, loadBestRefereeProfile } from './_shared/referee-intelligence'
import { reconcileFixtureReferee } from './_shared/referee-reconcile'

export const config={schedule:'40 * * * *'}

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function clamp(value:number,min=0,max=100){return Math.max(min,Math.min(max,value))}
function chunks<T>(items:T[],size=100){const out:T[][]=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out}

type Evidence={key:string;label?:string;display?:string;score:number}
type Snapshot={id:string;model_version:string;selection_key:string;data_quality:number;evidence:any;features:any}

const CONFIG:Record<string,{weights:Record<string,number>;keys:string[]}>= {
  'v0-research':{
    weights:{recent:.24,venue:.20,opponent:.17,referee:.18,season:.11,h2h:.10},
    keys:['home_cards_1_5','away_cards_1_5'],
  },
  'v1-expanded-research':{
    weights:{recent:.18,venue:.25,opponent:.15,season:.12,h2h:.07,referee:.18,lineup:.05},
    keys:['match_cards_3_5'],
  },
}

function recompute(evidence:Evidence[],weights:Record<string,number>,dataQuality:number){
  let total=0,used=0
  for(const item of evidence){
    const weight=weights[item.key]
    if(!weight) continue
    total+=Number(item.score??0)*weight
    used+=weight
  }
  const raw=used?total/used:0
  return Math.round(raw*(.88+clamp(Number(dataQuality??0))/100*.12))
}

function contextFor(snapshot:Snapshot):'home'|'away'|'match'{
  if(snapshot.selection_key==='home_cards_1_5') return 'home'
  if(snapshot.selection_key==='away_cards_1_5') return 'away'
  return 'match'
}

export async function refineFixtureRefereeIntelligence(
  supabase:ReturnType<typeof createClient>,
  fixtureId:string,
  requestedModelVersion?:string|null,
){
  const modelVersions=requestedModelVersion&&CONFIG[requestedModelVersion]?[requestedModelVersion]:Object.keys(CONFIG)
  let {data:fixture,error:fixtureError}=await supabase.from('fixtures').select('id,referee_id,kickoff,status').eq('id',fixtureId).maybeSingle()
  if(fixtureError) throw fixtureError
  if(!fixture) return {fixtureId,refined:0,reason:'Fixture not found'}

  const {data:context,error:contextError}=await supabase.from('manual_match_context')
    .select('referee_name,referee_confirmed')
    .eq('fixture_id',fixtureId)
    .maybeSingle()
  if(contextError) throw contextError
  if(!context?.referee_confirmed||!String(context.referee_name??'').trim()){
    return {fixtureId,refined:0,reason:'Referee not explicitly confirmed'}
  }

  let reconciliation:any=null
  let profile=fixture.referee_id?await loadBestRefereeProfile(supabase,fixture.referee_id):null
  if(!profile||Number(profile.matches_sample??0)<3){
    try{
      reconciliation=await reconcileFixtureReferee(supabase,fixtureId)
      const refreshed=await supabase.from('fixtures').select('id,referee_id,kickoff,status').eq('id',fixtureId).maybeSingle()
      if(refreshed.error) throw refreshed.error
      if(refreshed.data) fixture=refreshed.data
      profile=fixture?.referee_id?await loadBestRefereeProfile(supabase,fixture.referee_id):null
    }catch(error){reconciliation={matched:false,error:error instanceof Error?error.message:String(error)}}
  }

  if(!fixture?.referee_id) return {fixtureId,refined:0,reason:'No linked referee',reconciliation}
  if(!profile||Number(profile.matches_sample??0)<3) return {fixtureId,refined:0,reason:'No usable referee profile',reconciliation}

  const keys=[...new Set(modelVersions.flatMap((version)=>CONFIG[version].keys))]
  const {data:snapshots,error:snapshotError}=await supabase.from('feature_snapshots')
    .select('id,model_version,selection_key,data_quality,evidence,features')
    .eq('fixture_id',fixtureId)
    .in('model_version',modelVersions)
    .in('selection_key',keys)
  if(snapshotError) throw snapshotError

  let refined=0
  const details:any[]=[]
  for(const raw of snapshots??[]){
    const snapshot=raw as Snapshot
    const cfg=CONFIG[snapshot.model_version]
    if(!cfg||!cfg.keys.includes(snapshot.selection_key)) continue
    const intel=buildRefereeIntelligence(profile,contextFor(snapshot))
    if(!intel.usable) continue

    const existingEvidence=Array.isArray(snapshot.evidence)?snapshot.evidence as Evidence[]:[]
    const evidence=existingEvidence.map((item)=>item.key==='referee'?{
      ...item,
      label:'Referee intelligence',
      display:intel.display,
      score:Math.round(intel.score),
    }:item)
    if(!evidence.some((item)=>item.key==='referee')) continue

    const confidence=recompute(evidence,cfg.weights,Number(snapshot.data_quality??0))
    const features={...(snapshot.features&&typeof snapshot.features==='object'?snapshot.features:{}),refereeIntelligence:intel}
    if('refCards' in features) features.refCards=intel.yellowCardsPerMatch
    if('refereeCards' in features) features.refereeCards=intel.yellowCardsPerMatch

    const {error:updateSnapshotError}=await supabase.from('feature_snapshots').update({
      evidence,features,calculated_at:new Date().toISOString(),
    }).eq('id',snapshot.id)
    if(updateSnapshotError){details.push({snapshotId:snapshot.id,error:updateSnapshotError.message});continue}

    const {error:updatePredictionError}=await supabase.from('predictions').update({
      confidence,evidence,generated_at:new Date().toISOString(),
    }).eq('feature_snapshot_id',snapshot.id).eq('model_version',snapshot.model_version)
    if(updatePredictionError){details.push({snapshotId:snapshot.id,error:updatePredictionError.message});continue}

    refined+=1
    details.push({snapshotId:snapshot.id,model:snapshot.model_version,selectionKey:snapshot.selection_key,confidence,refereeScore:intel.score,reliabilityPct:intel.reliabilityPct,sample:intel.sample,sources:intel.sources})
  }

  return {fixtureId,refined,modelVersions,profile,reconciliation,details}
}

export default async(request?:Request)=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const url=request?new URL(request.url):null
  const requestedFixtureId=url?.searchParams.get('fixture_id')??null
  const requestedModelVersion=url?.searchParams.get('model_version')??null
  let fixtureIds:string[]=[]
  if(requestedFixtureId){
    fixtureIds=[requestedFixtureId]
  }else{
    const now=new Date(),horizon=new Date(now.getTime()+7*86400000)
    const {data,error}=await supabase.from('fixtures')
      .select('id')
      .in('status',['scheduled','live'])
      .gte('kickoff',new Date(now.getTime()-3*3600000).toISOString())
      .lte('kickoff',horizon.toISOString())
      .order('kickoff',{ascending:true})
    if(error) throw error
    const allIds=(data??[]).map((x:any)=>x.id)
    const contexts:any[]=[]
    for(const batch of chunks(allIds)){
      const {data:contextRows,error:contextError}=await supabase.from('manual_match_context')
        .select('fixture_id,referee_name,referee_confirmed')
        .in('fixture_id',batch)
      if(contextError) throw contextError
      contexts.push(...(contextRows??[]))
    }
    const confirmed=new Set(contexts.filter((c:any)=>c.referee_confirmed&&String(c.referee_name??'').trim()).map((c:any)=>c.fixture_id))
    fixtureIds=allIds.filter((id:string)=>confirmed.has(id))
  }

  const results:any[]=[]
  let refined=0
  for(const fixtureId of fixtureIds){
    try{const result=await refineFixtureRefereeIntelligence(supabase,fixtureId,requestedModelVersion);results.push(result);refined+=Number(result.refined??0)}
    catch(error){results.push({fixtureId,refined:0,error:error instanceof Error?error.message:String(error)})}
  }

  return new Response(JSON.stringify({
    ok:true,checked:fixtureIds.length,refined,modelVersion:requestedModelVersion??'all',
    errors:results.filter((r)=>r.error).length,
    calibrationPerformedHere:false,
    noProcessingCap:true,
    lookaheadDays:7,
    results,
    note:'Referee refinement only. Calibration/publication belongs exclusively to dedicated downstream stages.',
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
