import { createClient } from '@supabase/supabase-js'

type Supabase=ReturnType<typeof createClient>

function clean(value:string){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
function slug(value:string){return clean(value).replace(/ /g,'-')}
function textFromHtml(html:string){return html.replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&#x27;/gi,"'").replace(/&quot;/gi,'"').replace(/\s+/g,' ').trim()}
function numberMatch(text:string,re:RegExp){const m=text.match(re);const n=m?Number(m[1]):NaN;return Number.isFinite(n)?n:null}

async function fetchHtml(url:string){
  const response=await fetch(url,{redirect:'follow',headers:{accept:'text/html,application/xhtml+xml','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.9 referee-profile'}})
  if(!response.ok) throw new Error(`FotMob HTML ${response.status}`)
  return {html:await response.text(),finalUrl:response.url}
}

function refereeLinkFromMatch(html:string,officialName:string){
  const wanted=slug(officialName)
  const links=[...html.matchAll(/\/referees\/(\d+)\/([^"'?#<\\]+)/gi)].map((m)=>({id:m[1],slug:m[2]}))
  if(!links.length) return null
  const exact=links.find((x)=>clean(x.slug)===clean(wanted)||clean(x.slug).includes(clean(officialName))||clean(officialName).includes(clean(x.slug)))
  return exact??links[0]
}

function parseProfile(html:string){
  const text=textFromHtml(html)
  const matches=numberMatch(text,/(\d+)\s+Matches\b/i)
  const yellowTotal=numberMatch(text,/(\d+)\s+Yellow\b/i)
  const redTotal=numberMatch(text,/(\d+)\s+Red\b/i)
  const penaltiesTotal=numberMatch(text,/(\d+)\s+Penalties\b/i)
  const yellowsPerMatch=numberMatch(text,/Yellow cards\s+([0-9]+(?:\.[0-9]+)?)\s*\/\s*match/i)
  const foulsPerMatch=numberMatch(text,/Fouls\s+([0-9]+(?:\.[0-9]+)?)\s*\/\s*match/i)
  if(!matches||matches<3||yellowsPerMatch==null) return null
  const redPerMatch=redTotal==null?null:Math.round((redTotal/matches)*1000)/1000
  const penaltiesPerMatch=penaltiesTotal==null?null:Math.round((penaltiesTotal/matches)*1000)/1000
  return {matches,yellowTotal,redTotal,penaltiesTotal,yellowsPerMatch,foulsPerMatch,redPerMatch,penaltiesPerMatch}
}

export async function hydrateFixtureRefereeProfile(supabase:Supabase,fixtureId:string,officialName:string){
  const {data:fixture,error}=await supabase.from('fixtures').select('id,source,source_fixture_id,referee_id').eq('id',fixtureId).maybeSingle()
  if(error||!fixture) return {hydrated:false,reason:error?.message??'Fixture not found'}
  if(!fixture.referee_id) return {hydrated:false,reason:'Fixture has no referee id'}
  if(fixture.source!=='fotmob'||!fixture.source_fixture_id) return {hydrated:false,reason:'Fixture is not FotMob-backed'}

  const today=new Date().toISOString().slice(0,10)
  const {data:existing}=await supabase.from('referee_profiles').select('matches_sample,source').eq('referee_id',fixture.referee_id).gte('as_of_date',today).order('matches_sample',{ascending:false}).limit(1).maybeSingle()
  if(existing&&Number(existing.matches_sample??0)>=3) return {hydrated:true,cached:true,matchesSample:Number(existing.matches_sample),source:existing.source}

  const matchPage=await fetchHtml(`https://www.fotmob.com/match/${encodeURIComponent(String(fixture.source_fixture_id))}`)
  const ref=refereeLinkFromMatch(matchPage.html,officialName)
  if(!ref) return {hydrated:false,reason:'Referee link not exposed on FotMob match page'}

  const profilePage=await fetchHtml(`https://www.fotmob.com/referees/${ref.id}/${slug(officialName)}`)
  const parsed=parseProfile(profilePage.html)
  if(!parsed) return {hydrated:false,refereeSourceId:ref.id,reason:'FotMob referee summary could not be parsed safely'}

  const row={
    referee_id:fixture.referee_id,
    as_of_date:today,
    matches_sample:parsed.matches,
    yellow_cards_per_match:parsed.yellowsPerMatch,
    red_cards_per_match:parsed.redPerMatch,
    fouls_per_match:parsed.foulsPerMatch,
    penalties_per_match:parsed.penaltiesPerMatch,
    home_yellows_per_match:null,
    away_yellows_per_match:null,
    source:'fotmob-referee-page',
  }
  const {error:upsertError}=await supabase.from('referee_profiles').upsert(row,{onConflict:'referee_id,as_of_date,source'})
  if(upsertError) throw upsertError
  return {hydrated:true,cached:false,refereeSourceId:ref.id,matchesSample:parsed.matches,yellowCardsPerMatch:parsed.yellowsPerMatch,redCardsPerMatch:parsed.redPerMatch,foulsPerMatch:parsed.foulsPerMatch,penaltiesPerMatch:parsed.penaltiesPerMatch,source:'fotmob-referee-page',profileUrl:profilePage.finalUrl}
}
