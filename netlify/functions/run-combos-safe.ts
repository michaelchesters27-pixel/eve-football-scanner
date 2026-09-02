import { createClient } from '@supabase/supabase-js'

type HistRow={
  fixture_id:string;kickoff:string;team_id:string;venue:'home'|'away';goals:number|null;opponent_goals:number|null;
  yellow_cards:number|null;opponent_yellow_cards:number|null;corners:number|null;opponent_corners:number|null;
  home_goals:number|null;away_goals:number|null;half_time_home_goals:number|null;half_time_away_goals:number|null;
}
type Signal={id:string;selection:string;confidence:number;data_quality:number;fair_probability:number;generated_at:string;feature_snapshots:{selection_key:string}|null}

const MODEL='v1-combo-research'
const MAX_SIGNAL_AGE_MS=2*60*60*1000
const SUPPORTED_KEYS=new Set(['over_1_5','second_half_0_5','btts_yes','first_half_0_5','match_cards_3_5','match_corners_8_5'])

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function pct(n:number,d:number){return d?Math.round(n/d*1000)/10:0}
function totalGoals(r:HistRow){return (r.home_goals??0)+(r.away_goals??0)}
function firstHalfGoals(r:HistRow){return (r.half_time_home_goals??0)+(r.half_time_away_goals??0)}
function secondHalfGoals(r:HistRow){return totalGoals(r)-firstHalfGoals(r)}
function totalCards(r:HistRow){return (r.yellow_cards??0)+(r.opponent_yellow_cards??0)}
function totalCorners(r:HistRow){return (r.corners??0)+(r.opponent_corners??0)}
function hit(key:string,r:HistRow){
  if(key==='over_1_5') return totalGoals(r)>=2
  if(key==='second_half_0_5') return secondHalfGoals(r)>=1
  if(key==='btts_yes') return (r.goals??0)>0&&(r.opponent_goals??0)>0
  if(key==='first_half_0_5') return firstHalfGoals(r)>=1
  if(key==='match_cards_3_5') return totalCards(r)>=4
  if(key==='match_corners_8_5') return totalCorners(r)>=9
  return false
}

export default async(request?:Request)=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),horizon=new Date(now.getTime()+7*86400000)
  const requestedFixtureId=request?new URL(request.url).searchParams.get('fixture_id'):null
  let fixtureQuery=supabase.from('fixtures').select('id,kickoff,home_team_id,away_team_id').eq('status','scheduled').gte('kickoff',now.toISOString()).lt('kickoff',horizon.toISOString()).order('kickoff')
  if(requestedFixtureId) fixtureQuery=fixtureQuery.eq('id',requestedFixtureId)
  const {data:fixtures,error:fixtureError}=await fixtureQuery
  if(fixtureError) return new Response(JSON.stringify({ok:false,error:fixtureError.message}),{status:500,headers:{'content-type':'application/json'}})
  const fixtureRows=fixtures??[]
  const fixtureIds=fixtureRows.map((f:any)=>f.id)

  // Rebuild atomically from the currently eligible fixture universe: remove old
  // recommendations first, then write only combinations supported by fresh,
  // calibrated legs. This prevents a previous combo surviving after one of its
  // legs is suppressed or becomes stale.
  if(fixtureIds.length){
    for(let i=0;i<fixtureIds.length;i+=80){
      const {error}=await supabase.from('combo_recommendations').delete().eq('model_version',MODEL).in('fixture_id',fixtureIds.slice(i,i+80))
      if(error) throw error
    }
  }

  let written=0,skippedStale=0,skippedInsufficient=0
  const summaries:any[]=[]
  const freshFloor=new Date(now.getTime()-MAX_SIGNAL_AGE_MS).toISOString()

  for(const fixture of fixtureRows as any[]){
    const {data:signalRows,error:signalError}=await supabase.from('predictions')
      .select('id,selection,confidence,data_quality,fair_probability,generated_at,feature_snapshots(selection_key)')
      .eq('fixture_id',fixture.id)
      .eq('publish_status','published')
      .not('fair_probability','is',null)
      .gte('generated_at',freshFloor)
      .in('model_version',['v0-research','v1-expanded-research'])
      .order('confidence',{ascending:false})
    if(signalError){skippedInsufficient+=1;continue}

    const signals=((signalRows??[]) as unknown as Signal[]).filter((s)=>SUPPORTED_KEYS.has(s.feature_snapshots?.selection_key??''))
    const distinct:Signal[]=[]
    const seen=new Set<string>()
    for(const signal of signals){
      const key=signal.feature_snapshots?.selection_key??''
      if(seen.has(key)) continue
      seen.add(key);distinct.push(signal)
      if(distinct.length===3) break
    }
    if(distinct.length<2){
      const allPublished=await supabase.from('predictions').select('id',{count:'exact',head:true}).eq('fixture_id',fixture.id).eq('publish_status','published').in('model_version',['v0-research','v1-expanded-research'])
      if((allPublished.count??0)>=2) skippedStale+=1
      else skippedInsufficient+=1
      continue
    }

    const [homeResult,awayResult]=await Promise.all([
      supabase.from('team_match_flat').select('*').eq('team_id',fixture.home_team_id).eq('venue','home').lt('kickoff',fixture.kickoff).order('kickoff',{ascending:false}).limit(20),
      supabase.from('team_match_flat').select('*').eq('team_id',fixture.away_team_id).eq('venue','away').lt('kickoff',fixture.kickoff).order('kickoff',{ascending:false}).limit(20),
    ])
    if(homeResult.error||awayResult.error){skippedInsufficient+=1;continue}
    const dedupe=new Map<string,HistRow>()
    for(const row of [...(homeResult.data??[]),...(awayResult.data??[])] as HistRow[]) dedupe.set(row.fixture_id,row)
    const sample=[...dedupe.values()]
    if(sample.length<10){skippedInsufficient+=1;continue}

    const legs=distinct.map((s)=>({key:s.feature_snapshots?.selection_key??'',selection:s.selection,eveScore:s.confidence,dataQuality:s.data_quality,fairProbability:Number(s.fair_probability)}))
    const singles=legs.map((leg)=>{const hits=sample.filter((r)=>hit(leg.key,r)).length;return {...leg,probability:pct(hits,sample.length),hits,sample:sample.length}})
    const doubles:any[]=[]
    for(let i=0;i<legs.length;i++) for(let j=i+1;j<legs.length;j++){
      const hits=sample.filter((r)=>hit(legs[i].key,r)&&hit(legs[j].key,r)).length
      doubles.push({legs:[legs[i].selection,legs[j].selection],keys:[legs[i].key,legs[j].key],probability:pct(hits,sample.length),hits,sample:sample.length})
    }
    doubles.sort((a,b)=>b.probability-a.probability)
    let treble:any=null
    if(legs.length>=3){
      const hits=sample.filter((r)=>legs.every((leg)=>hit(leg.key,r))).length
      treble={legs:legs.map((l)=>l.selection),keys:legs.map((l)=>l.key),probability:pct(hits,sample.length),hits,sample:sample.length}
    }
    const dataQuality=Math.min(100,Math.round(sample.length/30*100))
    const calculatedAt=new Date().toISOString()
    const {error:writeError}=await supabase.from('combo_recommendations').upsert({
      fixture_id:fixture.id,model_version:MODEL,sample_size:sample.length,singles,doubles,treble,
      explanation:`Joint probabilities use ${sample.length} comparable historical home/away matches. Every leg is a fresh calibrated EVE selection; doubles and trebles are measured as actual joint hit frequencies and are never created by multiplying single probabilities.`,
      data_quality:dataQuality,calculated_at:calculatedAt,
    },{onConflict:'fixture_id,model_version'})
    if(writeError) throw writeError
    written+=1
    summaries.push({fixtureId:fixture.id,sample:sample.length,legs:legs.map((l)=>l.key),bestDouble:doubles[0]?.probability??null,treble:treble?.probability??null,calculatedAt})
  }

  return new Response(JSON.stringify({
    ok:true,model:MODEL,fixtures:fixtureRows.length,written,skippedStale,skippedInsufficient,
    signalFreshnessHours:2,
    note:'Combo Lab now rebuilds only from current published predictions that have a calibrated fair probability and were regenerated within two hours. Old recommendations are deleted before the rebuild, so stale legs cannot survive.',
    summaries,
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
