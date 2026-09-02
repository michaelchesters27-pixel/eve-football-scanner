import { createClient } from '@supabase/supabase-js'

type Supabase=ReturnType<typeof createClient>

function clean(value:string){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
function slug(value:string){return clean(value).replace(/ /g,'-')}
function text(value:any):string{
  if(value==null) return ''
  if(typeof value==='string'||typeof value==='number') return String(value).trim()
  if(typeof value==='object') return String(value.fullName??value.text??value.name??'').trim()
  return ''
}
function textFromHtml(html:string){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#x27;/gi,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').trim()}
function numberMatch(text:string,re:RegExp){const m=text.match(re);const n=m?Number(m[1]):NaN;return Number.isFinite(n)?n:null}
function tokens(value:string){return clean(value).split(' ').filter(Boolean)}
function round3(value:number|null){return value==null?null:Math.round(value*1000)/1000}
function nameSimilarity(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb) return 0
  if(aa===bb) return 1
  const at=tokens(aa),bt=tokens(bb),aset=new Set(at),bset=new Set(bt)
  const common=[...aset].filter((t)=>bset.has(t)).length
  const overlap=common/Math.max(at.length,bt.length,1)
  const surname=at.at(-1)===bt.at(-1)?1:0
  const firstInitial=at[0]?.[0]&&bt[0]?.[0]&&at[0][0]===bt[0][0]?1:0
  const subset=Math.min(at.length,bt.length)>=2&&common===Math.min(at.length,bt.length)?1:0
  return Math.min(1,overlap*.58+surname*.22+firstInitial*.08+subset*.12)
}

async function fetchHtml(url:string){
  const response=await fetch(url,{redirect:'follow',headers:{accept:'text/html,application/xhtml+xml','user-agent':'Mozilla/5.0 EVE-Football-Scanner/1.1 referee-profile'}})
  if(!response.ok) throw new Error(`FotMob HTML ${response.status}`)
  return {html:await response.text(),finalUrl:response.url}
}

async function fetchMatchDetails(matchId:string){
  const urls=[
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ]
  let last='FotMob match details failed'
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/1.1 referee-profile'}})
      if(!response.ok){last=`FotMob JSON ${response.status}`;continue}
      const body=await response.json()
      if(body&&typeof body==='object') return body
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

function numberValue(value:any){const n=Number(value);return Number.isFinite(n)?n:null}
function jsonProfile(raw:any){
  if(!raw||!Array.isArray(raw.stats)) return null
  const byType=new Map(raw.stats.map((s:any)=>[clean(String(s?.type??'')),s]))
  const matchesStat=byType.get('matches') as any
  const yellowStat=byType.get('yellowcards') as any
  const redStat=byType.get('redcards') as any
  const foulStat=byType.get('fouls') as any
  const penaltyStat=byType.get('penalties') as any
  const matches=numberValue(matchesStat?.value??matchesStat?.total)
  const yellowsPerMatch=yellowStat?.valueType==='perMatch'?numberValue(yellowStat?.value):null
  const foulsPerMatch=foulStat?.valueType==='perMatch'?numberValue(foulStat?.value):null
  if(!matches||matches<3||yellowsPerMatch==null) return null
  const redTotal=numberValue(redStat?.total??(redStat?.valueType==='total'?redStat?.value:null))
  const penaltiesTotal=numberValue(penaltyStat?.total??(penaltyStat?.valueType==='total'?penaltyStat?.value:null))
  return {
    matches,
    yellowsPerMatch,
    redPerMatch:redTotal==null?null:round3(redTotal/matches),
    foulsPerMatch,
    penaltiesPerMatch:penaltiesTotal==null?null:round3(penaltiesTotal/matches),
  }
}

function refereeLinkFromMatch(html:string,officialName:string){
  const links=[...html.matchAll(/\/referees\/(\d+)\/([^"'?#<\\]+)/gi)].map((m)=>({id:m[1],slug:m[2]}))
  if(!links.length) return null
  const ranked=links.map((link)=>({...link,score:nameSimilarity(officialName,link.slug)})).sort((a,b)=>b.score-a.score)
  const best=ranked[0]
  const second=ranked[1]
  if(!best||best.score<.88) return null
  if(second&&second.score>=best.score-.025) return null
  return best
}

function parseProfile(html:string){
  const pageText=textFromHtml(html)
  const matches=numberMatch(pageText,/(\d+)\s+Matches\b/i)
  const redTotal=numberMatch(pageText,/(\d+)\s+Red\b/i)
  const penaltiesTotal=numberMatch(pageText,/(\d+)\s+Penalties\b/i)
  const yellowsPerMatch=numberMatch(pageText,/Yellow cards\s+([0-9]+(?:\.[0-9]+)?)\s*\/\s*match/i)
  const foulsPerMatch=numberMatch(pageText,/Fouls\s+([0-9]+(?:\.[0-9]+)?)\s*\/\s*match/i)
  if(!matches||matches<3||yellowsPerMatch==null) return null
  return {matches,yellowsPerMatch,foulsPerMatch,redPerMatch:redTotal==null?null:round3(redTotal/matches),penaltiesPerMatch:penaltiesTotal==null?null:round3(penaltiesTotal/matches)}
}

async function canonicalizeReferee(supabase:Supabase,fixture:any,officialName:string,sourceId:string){
  const canonicalKey=`fotmob-referee:${sourceId}`
  const {data:canonical}=await supabase.from('referees').select('id,name,source_key').eq('source_key',canonicalKey).maybeSingle()
  if(canonical?.id&&nameSimilarity(officialName,String(canonical.name??''))>=.9){
    if(fixture.referee_id!==canonical.id){
      const {error}=await supabase.from('fixtures').update({referee_id:canonical.id,updated_at:new Date().toISOString()}).eq('id',fixture.id)
      if(error) throw error
      fixture.referee_id=canonical.id
    }
    return canonical.id as string
  }

  const {data:current}=fixture.referee_id
    ? await supabase.from('referees').select('id,name,source_key').eq('id',fixture.referee_id).maybeSingle()
    : {data:null as any}
  if(current?.id&&nameSimilarity(officialName,String(current.name??''))>=.9){
    const sourceKey=String(current.source_key??'')
    if(!sourceKey||sourceKey.startsWith('fotmob-ref:')||sourceKey.startsWith('fotmob-referee:')){
      const {error}=await supabase.from('referees').update({source_key:canonicalKey,name:officialName}).eq('id',current.id)
      if(error) throw error
    }
    return current.id as string
  }

  const {data:created,error}=await supabase.from('referees').upsert({source_key:canonicalKey,name:officialName},{onConflict:'source_key'}).select('id').single()
  if(error||!created?.id) throw new Error(error?.message??'Could not save canonical FotMob referee')
  const {error:updateError}=await supabase.from('fixtures').update({referee_id:created.id,updated_at:new Date().toISOString()}).eq('id',fixture.id)
  if(updateError) throw updateError
  fixture.referee_id=created.id
  return created.id as string
}

async function saveProfile(supabase:Supabase,refereeId:string,profile:any,source:string){
  const today=new Date().toISOString().slice(0,10)
  const row={
    referee_id:refereeId,
    as_of_date:today,
    matches_sample:profile.matches,
    yellow_cards_per_match:profile.yellowsPerMatch,
    red_cards_per_match:profile.redPerMatch,
    fouls_per_match:profile.foulsPerMatch,
    penalties_per_match:profile.penaltiesPerMatch,
    home_yellows_per_match:null,
    away_yellows_per_match:null,
    source,
  }
  const {error}=await supabase.from('referee_profiles').upsert(row,{onConflict:'referee_id,as_of_date,source'})
  if(error) throw error
}

export async function hydrateFixtureRefereeProfile(supabase:Supabase,fixtureId:string,officialName:string){
  const {data:fixture,error}=await supabase.from('fixtures').select('id,source,source_fixture_id,referee_id').eq('id',fixtureId).maybeSingle()
  if(error||!fixture) return {hydrated:false,reason:error?.message??'Fixture not found'}
  if(fixture.source!=='fotmob'||!fixture.source_fixture_id) return {hydrated:false,reason:'Fixture is not FotMob-backed'}

  const today=new Date().toISOString().slice(0,10)
  if(fixture.referee_id){
    const {data:existing}=await supabase.from('referee_profiles').select('matches_sample,source').eq('referee_id',fixture.referee_id).gte('as_of_date',today).order('matches_sample',{ascending:false}).limit(1).maybeSingle()
    if(existing&&Number(existing.matches_sample??0)>=3) return {hydrated:true,cached:true,matchesSample:Number(existing.matches_sample),source:existing.source}
  }

  // Primary path: FotMob already sends a referee object containing the exact
  // referee id AND the usable stats in matchDetails. Do not throw that identity
  // away and try to rediscover it from client-rendered HTML.
  try{
    const payload=await fetchMatchDetails(String(fixture.source_fixture_id))
    const raw=refereeObject(payload)
    const rawName=text(raw)
    const sourceId=raw?.id==null?'':String(raw.id)
    if(raw&&sourceId&&nameSimilarity(officialName,rawName)>=.9){
      const refereeId=await canonicalizeReferee(supabase,fixture,officialName,sourceId)
      const parsed=jsonProfile(raw)
      if(parsed){
        await saveProfile(supabase,refereeId,parsed,'fotmob-match-details')
        return {hydrated:true,cached:false,directJson:true,refereeSourceId:sourceId,matchesSample:parsed.matches,yellowCardsPerMatch:parsed.yellowsPerMatch,redCardsPerMatch:parsed.redPerMatch,foulsPerMatch:parsed.foulsPerMatch,penaltiesPerMatch:parsed.penaltiesPerMatch,source:'fotmob-match-details'}
      }

      // Exact identity is known even if this match payload omitted the stats.
      const profilePage=await fetchHtml(`https://www.fotmob.com/referees/${sourceId}/${slug(officialName)}`)
      const pageParsed=parseProfile(profilePage.html)
      if(pageParsed){
        await saveProfile(supabase,refereeId,pageParsed,'fotmob-referee-page')
        return {hydrated:true,cached:false,directJsonIdentity:true,refereeSourceId:sourceId,matchesSample:pageParsed.matches,yellowCardsPerMatch:pageParsed.yellowsPerMatch,redCardsPerMatch:pageParsed.redPerMatch,foulsPerMatch:pageParsed.foulsPerMatch,penaltiesPerMatch:pageParsed.penaltiesPerMatch,source:'fotmob-referee-page',profileUrl:profilePage.finalUrl}
      }
    }
  }catch{
    // Keep the old HTML route only as a final fallback. Identity failures remain
    // fail-closed; EVE must never attach another referee's card record by guesswork.
  }

  if(!fixture.referee_id) return {hydrated:false,reason:'Fixture has no safely linked referee id'}
  const matchPage=await fetchHtml(`https://www.fotmob.com/match/${encodeURIComponent(String(fixture.source_fixture_id))}`)
  const ref=refereeLinkFromMatch(matchPage.html,officialName)
  if(!ref) return {hydrated:false,reason:'No unique safe FotMob referee identity match'}
  const profilePage=await fetchHtml(`https://www.fotmob.com/referees/${ref.id}/${slug(officialName)}`)
  const parsed=parseProfile(profilePage.html)
  if(!parsed) return {hydrated:false,refereeSourceId:ref.id,reason:'FotMob referee summary could not be parsed safely'}
  await saveProfile(supabase,fixture.referee_id,parsed,'fotmob-referee-page')
  return {hydrated:true,cached:false,refereeSourceId:ref.id,matchesSample:parsed.matches,yellowCardsPerMatch:parsed.yellowsPerMatch,redCardsPerMatch:parsed.redPerMatch,foulsPerMatch:parsed.foulsPerMatch,penaltiesPerMatch:parsed.penaltiesPerMatch,source:'fotmob-referee-page',profileUrl:profilePage.finalUrl}
}