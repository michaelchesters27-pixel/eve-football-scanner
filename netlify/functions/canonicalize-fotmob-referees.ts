import { createClient } from '@supabase/supabase-js'

type Supabase=ReturnType<typeof createClient>

const LOOKBACK_MS=3*60*60*1000
const LOOKAHEAD_MS=7*24*60*60*1000
const SOURCE='fotmob-referee-direct'

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function clean(value:any){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
function text(value:any):string{
  if(value==null) return ''
  if(typeof value==='string'||typeof value==='number') return String(value).trim()
  if(typeof value==='object') return String(value.fullName??value.text??value.name??[value.firstName,value.lastName].filter(Boolean).join(' ')??'').trim()
  return ''
}
function similarity(a:any,b:any){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb) return 0
  if(aa===bb) return 1
  const at=aa.split(' ').filter(Boolean),bt=bb.split(' ').filter(Boolean)
  const common=at.filter((t)=>bt.includes(t)).length
  const surname=at.at(-1)===bt.at(-1)?1:0
  const initial=at[0]?.[0]&&bt[0]?.[0]&&at[0][0]===bt[0][0]?1:0
  return Math.min(1,common/Math.max(at.length,bt.length,1)*.7+surname*.22+initial*.08)
}
function numberValue(value:any){const n=Number(value);return Number.isFinite(n)?n:null}
function round3(value:number|null){return value==null?null:Math.round(value*1000)/1000}
function sleep(ms:number){return new Promise((resolve)=>setTimeout(resolve,ms))}
function chunks<T>(items:T[],size=100){const out:T[][]=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out}

async function fetchDetails(matchId:string){
  const urls=[
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ]
  let last='FotMob matchDetails failed'
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/1.2 exact-referee'}})
      if(!response.ok){last=`${response.status} ${response.statusText}`;if(response.status===429) await sleep(800);continue}
      const payload=await response.json()
      if(payload&&typeof payload==='object') return payload
    }catch(error){last=error instanceof Error?error.message:String(error)}
  }
  throw new Error(last)
}

function refereeObject(payload:any){
  const raw=payload?.content?.matchFacts?.infoBox?.Referee
    ?? payload?.content?.matchFacts?.infoBox?.referee
    ?? payload?.general?.referee
  return raw&&typeof raw==='object'?raw:null
}

function profileFromRaw(raw:any){
  if(!raw||!Array.isArray(raw.stats)) return null
  const byType=new Map(raw.stats.map((s:any)=>[clean(s?.type),s]))
  const matchesStat:any=byType.get('matches')
  const yellowStat:any=byType.get('yellowcards')
  const redStat:any=byType.get('redcards')
  const foulStat:any=byType.get('fouls')
  const penaltyStat:any=byType.get('penalties')
  const matches=numberValue(matchesStat?.value??matchesStat?.total)
  const yellow=yellowStat?.valueType==='perMatch'?numberValue(yellowStat?.value):numberValue(yellowStat?.perMatch)
  const fouls=foulStat?.valueType==='perMatch'?numberValue(foulStat?.value):numberValue(foulStat?.perMatch)
  if(!matches||matches<3||yellow==null) return null
  const redTotal=numberValue(redStat?.total??(redStat?.valueType==='total'?redStat?.value:null))
  const redPerMatch=redStat?.valueType==='perMatch'?numberValue(redStat?.value):(redTotal==null?null:redTotal/matches)
  const penaltyTotal=numberValue(penaltyStat?.total??(penaltyStat?.valueType==='total'?penaltyStat?.value:null))
  const penaltiesPerMatch=penaltyStat?.valueType==='perMatch'?numberValue(penaltyStat?.value):(penaltyTotal==null?null:penaltyTotal/matches)
  return {matches,yellow,red:round3(redPerMatch),fouls,penalties:round3(penaltiesPerMatch)}
}

async function copyProfiles(supabase:Supabase,fromId:string,toId:string){
  if(fromId===toId) return 0
  const {data,error}=await supabase.from('referee_profiles')
    .select('as_of_date,matches_sample,yellow_cards_per_match,red_cards_per_match,fouls_per_match,penalties_per_match,home_yellows_per_match,away_yellows_per_match,source')
    .eq('referee_id',fromId)
  if(error) throw error
  let copied=0
  for(const row of data??[]){
    const {error:upsertError}=await supabase.from('referee_profiles').upsert({referee_id:toId,...row},{onConflict:'referee_id,as_of_date,source'})
    if(upsertError) throw upsertError
    copied+=1
  }
  return copied
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),from=new Date(now.getTime()-LOOKBACK_MS),to=new Date(now.getTime()+LOOKAHEAD_MS)
  const {data:run}=await supabase.from('source_sync_runs').insert({source:SOURCE,job_name:'canonicalize-fotmob-referees',status:'running'}).select('id').single()
  try{
    const {data:fixtures,error:fixtureError}=await supabase.from('fixtures')
      .select('id,source_fixture_id,referee_id,kickoff,status')
      .eq('source','fotmob')
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
    const contextMap=new Map(contexts.map((c:any)=>[c.fixture_id,c]))
    const results:any[]=[]
    let canonicalized=0,profilesWritten=0,profilesCopied=0,identityChanges=0

    for(const fixture of fixtureRows as any[]){
      const context=contextMap.get(fixture.id)
      if(!context?.referee_confirmed||!String(context.referee_name??'').trim()) continue
      const officialName=String(context.referee_name).trim()
      try{
        const payload=await fetchDetails(String(fixture.source_fixture_id))
        const raw=refereeObject(payload)
        const sourceId=raw?.id==null?'':String(raw.id)
        const sourceName=text(raw)
        if(!raw||!sourceId) throw new Error('FotMob did not supply an exact referee object/id')
        if(similarity(officialName,sourceName)<.9) throw new Error(`Referee identity mismatch: confirmed=${officialName}; FotMob=${sourceName||'unknown'}`)
        const canonicalKey=`fotmob-referee:${sourceId}`
        let {data:canonical,error:canonicalError}=await supabase.from('referees').select('id,name,source_key').eq('source_key',canonicalKey).maybeSingle()
        if(canonicalError) throw canonicalError
        if(!canonical){
          const created=await supabase.from('referees').insert({source_key:canonicalKey,name:sourceName||officialName}).select('id,name,source_key').single()
          if(created.error||!created.data) throw new Error(created.error?.message??'Could not create canonical referee')
          canonical=created.data
        }else if(clean(canonical.name)!==clean(sourceName||officialName)){
          const update=await supabase.from('referees').update({name:sourceName||officialName}).eq('id',canonical.id)
          if(update.error) throw update.error
        }

        const previousId=fixture.referee_id as string|null
        if(previousId&&previousId!==canonical.id) profilesCopied+=await copyProfiles(supabase,previousId,canonical.id)
        if(previousId!==canonical.id){
          const update=await supabase.from('fixtures').update({referee_id:canonical.id,updated_at:new Date().toISOString()}).eq('id',fixture.id)
          if(update.error) throw update.error
          identityChanges+=1
        }

        const profile=profileFromRaw(raw)
        if(profile){
          const today=new Date().toISOString().slice(0,10)
          const save=await supabase.from('referee_profiles').upsert({
            referee_id:canonical.id,as_of_date:today,matches_sample:profile.matches,
            yellow_cards_per_match:profile.yellow,red_cards_per_match:profile.red,
            fouls_per_match:profile.fouls,penalties_per_match:profile.penalties,
            home_yellows_per_match:null,away_yellows_per_match:null,source:'fotmob-match-details',
          },{onConflict:'referee_id,as_of_date,source'})
          if(save.error) throw save.error
          profilesWritten+=1
        }
        canonicalized+=1
        results.push({fixtureId:fixture.id,officialName,sourceName,refereeSourceId:sourceId,canonicalRefereeId:canonical.id,previousRefereeId:previousId,profileStored:Boolean(profile),matchesSample:profile?.matches??0})
      }catch(error){
        results.push({fixtureId:fixture.id,officialName,error:error instanceof Error?error.message:String(error)})
      }
      await sleep(60)
    }

    const errors=results.filter((r)=>r.error).length
    const summary={checked:results.length,canonicalized,identityChanges,profilesWritten,profilesCopied,errors,results}
    if(run?.id) await supabase.from('source_sync_runs').update({status:errors?'partial':'success',rows_upserted:canonicalized+profilesWritten,finished_at:new Date().toISOString(),error_message:errors?JSON.stringify(summary).slice(0,5000):null}).eq('id',run.id)
    return new Response(JSON.stringify({ok:true,...summary,note:'Exact FotMob referee ids are preserved as fotmob-referee:<id>. Existing historical profiles are copied onto the canonical identity before fixture links move.'}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
  }catch(error){
    if(run?.id) await supabase.from('source_sync_runs').update({status:'failed',finished_at:new Date().toISOString(),error_message:error instanceof Error?error.message:String(error)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'content-type':'application/json'}})
  }
}
