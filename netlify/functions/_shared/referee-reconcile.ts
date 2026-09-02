import { createClient } from '@supabase/supabase-js'
import { hydrateFixtureRefereeProfile } from './fotmob-referee-profile'

type Supabase = ReturnType<typeof createClient>
type RefIndex = { refs:any[]; latest:Map<string,any> }

function clean(value:string){
  return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')
}
function tokens(value:string){ return clean(value).split(' ').filter(Boolean) }
function similarity(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb) return 0
  if(aa===bb) return 1
  const at=tokens(aa),bt=tokens(bb)
  const aset=new Set(at),bset=new Set(bt)
  const common=[...aset].filter((t)=>bset.has(t))
  const minLen=Math.min(at.length,bt.length)
  const maxLen=Math.max(at.length,bt.length)
  const subset=minLen>=2&&common.length===minLen
  const firstInitial=Boolean(at[0]?.[0]&&bt[0]?.[0]&&at[0][0]===bt[0][0])
  const sharedSurname=common.some((t)=>t.length>=4&&t!==at[0]&&t!==bt[0])
  const includes=aa.includes(bb)||bb.includes(aa)
  if(subset&&firstInitial) return 0.96
  if(subset) return 0.92
  if(firstInitial&&sharedSurname&&common.length>=2) return 0.90
  const overlap=common.length/Math.max(maxLen,1)
  const lastSame=at.at(-1)===bt.at(-1)
  const penultimateSame=at.length>1&&bt.length>1&&at.at(-2)===bt.at(-2)
  return Math.min(1,overlap*.62+(lastSame ? .16 : 0)+(penultimateSame ? .10 : 0)+(firstInitial ? .06 : 0)+(includes ? .08 : 0))
}

async function buildIndex(supabase:Supabase,refresh=true):Promise<RefIndex>{
  if(refresh) await supabase.rpc('refresh_referee_profiles')
  const {data:refs,error:refsError}=await supabase.from('referees').select('id,name,source_key')
  if(refsError) throw refsError
  const ids=(refs??[]).map((r:any)=>r.id)
  const {data:profiles,error:profilesError}=ids.length
    ? await supabase.from('referee_profiles').select('referee_id,as_of_date,matches_sample,yellow_cards_per_match,red_cards_per_match,fouls_per_match,penalties_per_match,home_yellows_per_match,away_yellows_per_match,source').in('referee_id',ids)
    : {data:[] as any[],error:null}
  if(profilesError) throw profilesError
  const latest=new Map<string,any>()
  for(const row of profiles??[]){
    const prev=latest.get(row.referee_id)
    if(!prev||String(row.as_of_date??'')>String(prev.as_of_date??'')) latest.set(row.referee_id,row)
  }
  return {refs:refs??[],latest}
}

function bestMatch(index:RefIndex,officialName:string){
  const candidates=index.refs
    .map((ref:any)=>({ref,profile:index.latest.get(ref.id),score:similarity(officialName,String(ref.name??''))}))
    .filter((x:any)=>x.profile&&Number(x.profile.matches_sample??0)>=3&&x.score>=0.84)
    .sort((a:any,b:any)=>Math.abs(b.score-a.score)>.02 ? b.score-a.score : Number(b.profile.matches_sample??0)-Number(a.profile.matches_sample??0))
  return candidates[0]??null
}

async function reconcileWithIndex(supabase:Supabase,fixture:{id:string;referee_id:string|null},officialName:string,index:RefIndex){
  if(!officialName) return {fixtureId:fixture.id,officialName:null,matched:false,reason:'No confirmed referee name'}
  const best=bestMatch(index,officialName)
  if(!best) return {fixtureId:fixture.id,officialName,matched:false,currentRefereeId:fixture.referee_id,reason:'No safe historical referee profile match'}
  const changed=fixture.referee_id!==best.ref.id
  if(changed){
    const {error:updateError}=await supabase.from('fixtures').update({referee_id:best.ref.id,updated_at:new Date().toISOString()}).eq('id',fixture.id)
    if(updateError) throw updateError
  }
  return {fixtureId:fixture.id,officialName,matched:true,changed,historicalName:best.ref.name,similarity:Math.round(best.score*100)/100,profile:{matchesSample:Number(best.profile.matches_sample??0),yellowCardsPerMatch:best.profile.yellow_cards_per_match,redCardsPerMatch:best.profile.red_cards_per_match,foulsPerMatch:best.profile.fouls_per_match,penaltiesPerMatch:best.profile.penalties_per_match,homeYellowsPerMatch:best.profile.home_yellows_per_match,awayYellowsPerMatch:best.profile.away_yellows_per_match,asOfDate:best.profile.as_of_date,source:best.profile.source}}
}

export async function reconcileFixtureReferee(supabase:Supabase,fixtureId:string){
  let index=await buildIndex(supabase,true)
  const {data:fixture,error:fixtureError}=await supabase.from('fixtures').select('id,referee_id').eq('id',fixtureId).maybeSingle()
  if(fixtureError||!fixture) throw new Error(fixtureError?.message??'Fixture not found')
  const {data:context}=await supabase.from('manual_match_context').select('referee_name').eq('fixture_id',fixtureId).maybeSingle()
  const officialName=String(context?.referee_name??'').trim()
  let result=await reconcileWithIndex(supabase,fixture,officialName,index)
  if(!result.matched&&officialName){
    const direct=await hydrateFixtureRefereeProfile(supabase,fixtureId,officialName)
    if(direct.hydrated){
      index=await buildIndex(supabase,false)
      result=await reconcileWithIndex(supabase,fixture,officialName,index)
      return {...result,directFotMob:true,direct}
    }
    return {...result,direct}
  }
  return result
}

export async function reconcileActiveReferees(supabase:Supabase){
  const now=new Date()
  const from=new Date(now.getTime()-180*60000).toISOString()
  const to=new Date(now.getTime()+4*24*3600000).toISOString()
  const {data:fixtures,error}=await supabase.from('fixtures').select('id,referee_id').in('status',['scheduled','live']).gte('kickoff',from).lte('kickoff',to).order('kickoff',{ascending:true}).limit(120)
  if(error) throw error
  const ids=(fixtures??[]).map((f:any)=>f.id)
  if(!ids.length) return {checked:0,matched:0,changed:0,results:[]}
  const {data:contexts,error:contextError}=await supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed').in('fixture_id',ids)
  if(contextError) throw contextError
  const names=new Map((contexts??[]).filter((c:any)=>c.referee_confirmed&&c.referee_name).map((c:any)=>[c.fixture_id,String(c.referee_name).trim()]))
  let index=await buildIndex(supabase,true)
  const results:any[]=[]
  const unmatched:Array<{fixture:any;officialName:string;position:number}>=[]
  for(const fixture of fixtures??[]){
    const officialName=names.get(fixture.id)??''
    if(!officialName) continue
    try{
      const result=await reconcileWithIndex(supabase,fixture,officialName,index)
      const position=results.push(result)-1
      if(!result.matched) unmatched.push({fixture,officialName,position})
    }catch(error){results.push({fixtureId:fixture.id,matched:false,error:error instanceof Error?error.message:String(error)})}
  }

  // Previous code only hydrated unmatched.slice(0,12). When those first twelve
  // repeatedly failed, every referee after them was starved forever. The JSON-first
  // hydrator is cheap enough to cover the complete actionable window safely.
  let hydratedAny=false
  for(const item of unmatched.slice(0,60)){
    try{
      const direct=await hydrateFixtureRefereeProfile(supabase,item.fixture.id,item.officialName)
      if(direct.hydrated){hydratedAny=true;results[item.position]={...results[item.position],directFotMob:true,direct}}
      else results[item.position]={...results[item.position],direct}
    }catch(error){results[item.position]={...results[item.position],directError:error instanceof Error?error.message:String(error)}}
  }
  if(hydratedAny){
    index=await buildIndex(supabase,false)
    for(const item of unmatched){
      const retry=await reconcileWithIndex(supabase,item.fixture,item.officialName,index)
      results[item.position]={...results[item.position],...retry,directFotMob:true}
    }
  }
  return {checked:results.length,matched:results.filter((r:any)=>r.matched).length,changed:results.filter((r:any)=>r.changed).length,results}
}