import { createClient } from '@supabase/supabase-js'

const url=process.env.SUPABASE_URL
const key=process.env.SUPABASE_SERVICE_ROLE_KEY
if(!url||!key) throw new Error('Missing Supabase credentials')
const supabase=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})

const targetIds=[
  '971824c3-cdf0-4536-b507-96d79d25d26d', // Celtic v Aberdeen / Duncan Nicolson
  '778c23e7-b008-44f9-8b5b-a104fab01070', // known usable profile comparison
]

function text(value:any){
  try{return JSON.stringify(value)}catch{return String(value)}
}

function collectRefereePaths(value:any,path='root',out:Array<{path:string;value:any}>=[],depth=0){
  if(depth>12||value==null) return out
  if(Array.isArray(value)){
    value.slice(0,100).forEach((item,i)=>collectRefereePaths(item,`${path}[${i}]`,out,depth+1))
    return out
  }
  if(typeof value!=='object') return out
  for(const [k,v] of Object.entries(value)){
    const p=`${path}.${k}`
    if(/referee/i.test(k)) out.push({path:p,value:v})
    collectRefereePaths(v,p,out,depth+1)
  }
  return out
}

for(const fixtureId of targetIds){
  const {data:fixture,error}=await supabase.from('fixtures')
    .select('id,source,source_fixture_id,kickoff,referee_id')
    .eq('id',fixtureId).maybeSingle()
  if(error||!fixture){console.log('FIXTURE ERROR',fixtureId,error?.message);continue}
  const {data:context}=await supabase.from('manual_match_context')
    .select('referee_name,referee_confirmed').eq('fixture_id',fixtureId).maybeSingle()
  console.log('\n=== FIXTURE ===')
  console.log({fixtureId,source:fixture.source,sourceFixtureId:fixture.source_fixture_id,kickoff:fixture.kickoff,refereeId:fixture.referee_id,officialName:context?.referee_name,confirmed:context?.referee_confirmed})
  if(fixture.source!=='fotmob'||!fixture.source_fixture_id) continue
  const endpoint=`https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(String(fixture.source_fixture_id))}`
  const response=await fetch(endpoint,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-referee-debug'}})
  console.log('matchDetailsStatus',response.status)
  if(!response.ok) continue
  const body=await response.json()
  const direct={
    infoBoxReferee:body?.content?.matchFacts?.infoBox?.Referee,
    infoBoxRefereeLower:body?.content?.matchFacts?.infoBox?.referee,
    generalReferee:body?.general?.referee,
  }
  console.log('DIRECT',text(direct))
  const paths=collectRefereePaths(body).slice(0,40)
  console.log('REFEREE_PATHS',text(paths))
}
