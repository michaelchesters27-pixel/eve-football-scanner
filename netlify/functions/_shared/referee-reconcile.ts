import { createClient } from '@supabase/supabase-js'

type Supabase = ReturnType<typeof createClient>

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
  return Math.min(1,overlap*.62+(lastSame?.16:0)+(penultimateSame?.10:0)+(firstInitial?.06:0)+(includes?.08:0))
}

export async function reconcileFixtureReferee(supabase:Supabase,fixtureId:string){
  await supabase.rpc('refresh_referee_profiles')

  const {data:fixture,error:fixtureError}=await supabase.from('fixtures').select('id,referee_id').eq('id',fixtureId).maybeSingle()
  if(fixtureError||!fixture) throw new Error(fixtureError?.message??'Fixture not found')
  const {data:context}=await supabase.from('manual_match_context').select('referee_name,referee_confirmed').eq('fixture_id',fixtureId).maybeSingle()
  const officialName=String(context?.referee_name??'').trim()
  if(!officialName) return {fixtureId,officialName:null,matched:false,reason:'No confirmed referee name'}

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

  const candidates=(refs??[])
    .map((ref:any)=>({ref,profile:latest.get(ref.id),score:similarity(officialName,String(ref.name??''))}))
    .filter((x:any)=>x.profile&&Number(x.profile.matches_sample??0)>=3&&x.score>=0.84)
    .sort((a:any,b:any)=>{
      const scoreDiff=b.score-a.score
      if(Math.abs(scoreDiff)>.02) return scoreDiff
      return Number(b.profile.matches_sample??0)-Number(a.profile.matches_sample??0)
    })

  const best=candidates[0]
  if(!best) return {fixtureId,officialName,matched:false,currentRefereeId:fixture.referee_id,reason:'No safe historical referee profile match'}

  const changed=fixture.referee_id!==best.ref.id
  if(changed){
    const {error:updateError}=await supabase.from('fixtures').update({referee_id:best.ref.id,updated_at:new Date().toISOString()}).eq('id',fixtureId)
    if(updateError) throw updateError
  }

  return {
    fixtureId,
    officialName,
    matched:true,
    changed,
    historicalName:best.ref.name,
    similarity:Math.round(best.score*100)/100,
    profile:{
      matchesSample:Number(best.profile.matches_sample??0),
      yellowCardsPerMatch:best.profile.yellow_cards_per_match,
      redCardsPerMatch:best.profile.red_cards_per_match,
      foulsPerMatch:best.profile.fouls_per_match,
      penaltiesPerMatch:best.profile.penalties_per_match,
      homeYellowsPerMatch:best.profile.home_yellows_per_match,
      awayYellowsPerMatch:best.profile.away_yellows_per_match,
      asOfDate:best.profile.as_of_date,
      source:best.profile.source,
    },
  }
}

export async function reconcileActiveReferees(supabase:Supabase){
  const now=new Date()
  const from=new Date(now.getTime()-180*60000).toISOString()
  const to=new Date(now.getTime()+8*24*3600000).toISOString()
  const {data:fixtures,error}=await supabase.from('fixtures').select('id').in('status',['scheduled','live']).gte('kickoff',from).lte('kickoff',to).order('kickoff',{ascending:true}).limit(80)
  if(error) throw error
  const results=[]
  for(const fixture of fixtures??[]){
    try{ results.push(await reconcileFixtureReferee(supabase,fixture.id)) }
    catch(error){ results.push({fixtureId:fixture.id,matched:false,error:error instanceof Error?error.message:String(error)}) }
  }
  return {checked:fixtures?.length??0,matched:results.filter((r:any)=>r.matched).length,changed:results.filter((r:any)=>r.changed).length,results}
}
