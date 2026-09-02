import { createClient } from '@supabase/supabase-js'

type Supabase=ReturnType<typeof createClient>

export type RefereeProfile={
  referee_id?:string|null
  as_of_date?:string|null
  matches_sample?:number|null
  yellow_cards_per_match?:number|null
  red_cards_per_match?:number|null
  fouls_per_match?:number|null
  penalties_per_match?:number|null
  home_yellows_per_match?:number|null
  away_yellows_per_match?:number|null
  source?:string|null
  sources?:string[]
}

export type RefereeComponent={key:string;label:string;value:number;score:number;weight:number}
export type RefereeIntelligence={
  usable:boolean
  score:number
  rawScore:number
  reliabilityPct:number
  sample:number
  source:string|null
  sources:string[]
  yellowCardsPerMatch:number|null
  redCardsPerMatch:number|null
  foulsPerMatch:number|null
  penaltiesPerMatch:number|null
  homeYellowsPerMatch:number|null
  awayYellowsPerMatch:number|null
  display:string
  components:RefereeComponent[]
}

function clamp(value:number,min=0,max=100){return Math.max(min,Math.min(max,value))}
function finite(value:any):number|null{const n=Number(value);return value==null||value===''||!Number.isFinite(n)?null:n}
function dateMs(value:any){const n=Date.parse(String(value??''));return Number.isFinite(n)?n:0}
function sourceRank(source:any){
  const s=String(source??'').toLowerCase()
  if(s==='fotmob-referee-page') return 50
  if(s==='eve-derived') return 40
  if(s.includes('football-data')) return 30
  if(s.includes('fotmob')) return 25
  return 10
}
function round(value:number,digits=2){const p=10**digits;return Math.round(value*p)/p}

export function mergeRefereeProfiles(rows:any[]):RefereeProfile|null{
  const valid=(rows??[]).filter((row:any)=>row&&Number(row.matches_sample??0)>=3)
  if(!valid.length) return null
  const latest=Math.max(...valid.map((row:any)=>dateMs(row.as_of_date)))
  const windowMs=14*86400000
  const eligible=valid.filter((row:any)=>latest-dateMs(row.as_of_date)<=windowMs)
  const sorted=[...eligible].sort((a:any,b:any)=>dateMs(b.as_of_date)-dateMs(a.as_of_date)||sourceRank(b.source)-sourceRank(a.source)||Number(b.matches_sample??0)-Number(a.matches_sample??0))
  const pick=(field:string,preferred:string[]=[]):number|null=>{
    const candidates=sorted.filter((row:any)=>finite(row[field])!=null)
    if(!candidates.length) return null
    candidates.sort((a:any,b:any)=>{
      const ai=preferred.indexOf(String(a.source??'')),bi=preferred.indexOf(String(b.source??''))
      const ap=ai<0?preferred.length:ai,bp=bi<0?preferred.length:bi
      return ap-bp||dateMs(b.as_of_date)-dateMs(a.as_of_date)||sourceRank(b.source)-sourceRank(a.source)
    })
    return finite(candidates[0][field])
  }
  const sources=[...new Set(sorted.map((row:any)=>String(row.source??'unknown')))]
  const dates=sorted.map((row:any)=>String(row.as_of_date??'')).filter(Boolean).sort().reverse()
  const samples=sorted.map((row:any)=>Number(row.matches_sample??0)).filter(Number.isFinite)
  return {
    referee_id:sorted[0]?.referee_id??null,
    as_of_date:dates[0]??null,
    matches_sample:samples.length?Math.max(...samples):0,
    yellow_cards_per_match:pick('yellow_cards_per_match',['fotmob-referee-page','eve-derived']),
    red_cards_per_match:pick('red_cards_per_match',['fotmob-referee-page','eve-derived']),
    fouls_per_match:pick('fouls_per_match',['fotmob-referee-page','eve-derived']),
    penalties_per_match:pick('penalties_per_match',['fotmob-referee-page','eve-derived']),
    home_yellows_per_match:pick('home_yellows_per_match',['eve-derived','fotmob-referee-page']),
    away_yellows_per_match:pick('away_yellows_per_match',['eve-derived','fotmob-referee-page']),
    source:sources.length>1?`merged:${sources.join('+')}`:sources[0]??null,
    sources,
  }
}

export async function loadBestRefereeProfile(supabase:Supabase,refereeId:string|null|undefined):Promise<RefereeProfile|null>{
  if(!refereeId) return null
  const {data,error}=await supabase.from('referee_profiles')
    .select('referee_id,as_of_date,matches_sample,yellow_cards_per_match,red_cards_per_match,fouls_per_match,penalties_per_match,home_yellows_per_match,away_yellows_per_match,source')
    .eq('referee_id',refereeId)
    .order('as_of_date',{ascending:false})
    .limit(12)
  if(error) throw error
  return mergeRefereeProfiles(data??[])
}

function metricScore(value:number,baseline:number,slope:number,maxDistance=30){return clamp(50+(value-baseline)*slope,50-maxDistance,50+maxDistance)}

export function buildRefereeIntelligence(profile:RefereeProfile|null|undefined,context:'home'|'away'|'match'='match'):RefereeIntelligence{
  const sample=Math.max(0,Number(profile?.matches_sample??0))
  const yellows=finite(profile?.yellow_cards_per_match)
  const reds=finite(profile?.red_cards_per_match)
  const fouls=finite(profile?.fouls_per_match)
  const penalties=finite(profile?.penalties_per_match)
  const home=finite(profile?.home_yellows_per_match)
  const away=finite(profile?.away_yellows_per_match)
  const sources=profile?.sources?.length?profile.sources:[String(profile?.source??'')].filter(Boolean)
  const components:RefereeComponent[]=[]

  // Only referee dimensions that can be reconstructed in strict historical
  // walk-forward testing may alter the live score. Penalties are still pulled,
  // stored and displayed, but remain diagnostic until equivalent history exists.
  if(yellows!=null) components.push({key:'yellows',label:'Yellow cards',value:yellows,score:metricScore(yellows,4.0,11,32),weight:.50})
  if(fouls!=null) components.push({key:'fouls',label:'Fouls',value:fouls,score:metricScore(fouls,24,1.8,24),weight:.19})
  if(reds!=null) components.push({key:'reds',label:'Red cards',value:reds,score:metricScore(reds,.18,45,15),weight:.11})
  if(penalties!=null) components.push({key:'penalties',label:'Penalties · diagnostic',value:penalties,score:metricScore(penalties,.25,30,12),weight:0})

  if(context==='home'&&home!=null){
    const bias=away==null?0:home-away
    components.push({key:'side',label:'Home-card tendency',value:home,score:clamp(metricScore(home,2.0,11,24)+bias*7,26,78),weight:.20})
  }else if(context==='away'&&away!=null){
    const bias=home==null?0:away-home
    components.push({key:'side',label:'Away-card tendency',value:away,score:clamp(metricScore(away,2.0,11,24)+bias*7,26,78),weight:.20})
  }else if(context==='match'&&home!=null&&away!=null){
    components.push({key:'homeAway',label:'Home/away total',value:home+away,score:metricScore(home+away,4.0,10,22),weight:.20})
  }

  const weightUsed=components.reduce((sum,c)=>sum+c.weight,0)
  const raw=weightUsed?components.reduce((sum,c)=>sum+c.score*c.weight,0)/weightUsed:50
  const sampleReliability=clamp(sample/15,0,1)
  const completeness=clamp(weightUsed,0,1)
  const sourceReliability=sources.some((s)=>s==='fotmob-referee-page')?1:(sources.some((s)=>s==='eve-derived')?0.96:0.90)
  const reliability=sample>=3?sampleReliability*(.78+.22*completeness)*sourceReliability:0
  const finalScore=50+(raw-50)*reliability

  const parts=[
    yellows==null?null:`${yellows.toFixed(2)}Y`,
    fouls==null?null:`${fouls.toFixed(1)}F`,
    reds==null?null:`${reds.toFixed(3)}R`,
    penalties==null?null:`${penalties.toFixed(3)}P*`,
    home==null&&away==null?null:`H/A ${home==null?'—':home.toFixed(2)}/${away==null?'—':away.toFixed(2)}`,
  ].filter(Boolean)

  return {
    usable:sample>=3&&components.some((c)=>c.weight>0),
    score:round(finalScore,1),
    rawScore:round(raw,1),
    reliabilityPct:round(reliability*100,1),
    sample,
    source:profile?.source??null,
    sources,
    yellowCardsPerMatch:yellows,
    redCardsPerMatch:reds,
    foulsPerMatch:fouls,
    penaltiesPerMatch:penalties,
    homeYellowsPerMatch:home,
    awayYellowsPerMatch:away,
    display:parts.length?`${parts.join(' · ')} · n=${sample}`:'No usable referee history',
    components:components.map((c)=>({...c,score:round(c.score,1),value:round(c.value,3)})),
  }
}
