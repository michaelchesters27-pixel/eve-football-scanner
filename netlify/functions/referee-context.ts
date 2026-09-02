import { createClient } from '@supabase/supabase-js'
import { buildRefereeIntelligence, loadBestRefereeProfile } from './_shared/referee-intelligence'

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }
function round1(value:number|null|undefined){ const n=Number(value); return value==null||!Number.isFinite(n)?null:Math.round(n*10)/10 }
function round2(value:number|null|undefined){ const n=Number(value); return value==null||!Number.isFinite(n)?null:Math.round(n*100)/100 }
function tendency(score:number|null,usable:boolean){
  if(!usable||score==null) return {level:'AWAITING HISTORY',impact:'Referee is confirmed, but EVE has not linked a usable historical referee sample yet.'}
  if(score>=62) return {level:'VERY CARD HEAVY',impact:'Full referee profile materially raises the card-market expectation.'}
  if(score>=55) return {level:'CARD HEAVY',impact:'Full referee profile raises the card-market expectation.'}
  if(score<=42) return {level:'LOW CARD',impact:'Full referee profile lowers the card-market expectation.'}
  return {level:'NORMAL RANGE',impact:'Full referee profile is close to neutral for the card model.'}
}
function sampleLabel(matches:number){
  if(matches>=25) return 'STRONG SAMPLE'
  if(matches>=12) return 'GOOD SAMPLE'
  if(matches>=6) return 'DEVELOPING SAMPLE'
  if(matches>=3) return 'THIN SAMPLE'
  return 'NO USABLE SAMPLE'
}

export default async(request:Request)=>{
  const fixtureId=new URL(request.url).searchParams.get('fixture_id')
  if(!fixtureId) return new Response(JSON.stringify({ok:false,error:'fixture_id is required'}),{status:400,headers:{'content-type':'application/json'}})
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})

  const {data:fixture,error:fixtureError}=await supabase.from('fixtures').select('id,referee_id').eq('id',fixtureId).maybeSingle()
  if(fixtureError) return new Response(JSON.stringify({ok:false,error:fixtureError.message}),{status:500,headers:{'content-type':'application/json'}})
  if(!fixture) return new Response(JSON.stringify({ok:false,error:'Fixture not found'}),{status:404,headers:{'content-type':'application/json'}})

  const {data:manual}=await supabase.from('manual_match_context').select('referee_name,referee_confirmed').eq('fixture_id',fixtureId).maybeSingle()
  if(!fixture.referee_id){
    return new Response(JSON.stringify({ok:true,confirmed:Boolean(manual?.referee_confirmed),name:manual?.referee_name??null,profile:null,tendency:tendency(null,false),sampleLabel:'NO USABLE SAMPLE'}),{headers:{'content-type':'application/json'}})
  }

  const [{data:referee},profile]=await Promise.all([
    supabase.from('referees').select('id,name,source_key').eq('id',fixture.referee_id).maybeSingle(),
    loadBestRefereeProfile(supabase,fixture.referee_id),
  ])
  const intel=buildRefereeIntelligence(profile,'match')
  const matches=Number(profile?.matches_sample??0)

  return new Response(JSON.stringify({
    ok:true,
    confirmed:Boolean(manual?.referee_confirmed||referee?.id),
    name:manual?.referee_name??referee?.name??null,
    historicalIdentity:referee?.name??null,
    profile:profile?{
      matchesSample:matches,
      yellowCardsPerMatch:round2(profile.yellow_cards_per_match),
      redCardsPerMatch:round2(profile.red_cards_per_match),
      foulsPerMatch:round1(profile.fouls_per_match),
      penaltiesPerMatch:round2(profile.penalties_per_match),
      homeYellowsPerMatch:round2(profile.home_yellows_per_match),
      awayYellowsPerMatch:round2(profile.away_yellows_per_match),
      asOfDate:profile.as_of_date,
      source:profile.source,
      sources:profile.sources??[],
    }:null,
    refereeModel:{score:intel.score,reliabilityPct:intel.reliabilityPct,components:intel.components,display:intel.display},
    tendency:tendency(intel.score,intel.usable),
    sampleLabel:sampleLabel(matches),
    modelUse:'EVE merges safe referee sources. Yellows, fouls, reds and home/away card tendency can influence the reliability-shrunk card score. Penalties are still pulled and displayed but remain diagnostic until equivalent walk-forward history exists. Missing fields stay missing; they are never treated as zero.',
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
