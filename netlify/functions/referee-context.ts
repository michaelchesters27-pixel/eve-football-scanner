import { createClient } from '@supabase/supabase-js'

function env(name:string){ const value=process.env[name]; if(!value) throw new Error(`Missing required environment variable: ${name}`); return value }
function round1(value:number|null|undefined){ const n=Number(value); return Number.isFinite(n)?Math.round(n*10)/10:null }
function round2(value:number|null|undefined){ const n=Number(value); return Number.isFinite(n)?Math.round(n*100)/100:null }
function tendency(cards:number|null){
  if(cards==null) return {level:'AWAITING HISTORY',impact:'Referee is confirmed, but EVE has not linked a usable historical referee sample yet.'}
  if(cards>=5.2) return {level:'VERY CARD HEAVY',impact:'Raises the match-card expectation materially.'}
  if(cards>=4.3) return {level:'CARD HEAVY',impact:'Raises the match-card expectation.'}
  if(cards<=2.8) return {level:'LOW CARD',impact:'Lowers the match-card expectation.'}
  return {level:'NORMAL RANGE',impact:'Close to neutral for the match-card model.'}
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
    return new Response(JSON.stringify({ok:true,confirmed:Boolean(manual?.referee_confirmed),name:manual?.referee_name??null,profile:null,tendency:tendency(null),sampleLabel:'NO USABLE SAMPLE'}),{headers:{'content-type':'application/json'}})
  }

  const [{data:referee},{data:profile}]=await Promise.all([
    supabase.from('referees').select('id,name,source_key').eq('id',fixture.referee_id).maybeSingle(),
    supabase.from('referee_profiles').select('as_of_date,matches_sample,yellow_cards_per_match,red_cards_per_match,fouls_per_match,penalties_per_match,home_yellows_per_match,away_yellows_per_match,source').eq('referee_id',fixture.referee_id).order('as_of_date',{ascending:false}).limit(1).maybeSingle(),
  ])

  const cards=profile?.yellow_cards_per_match==null?null:Number(profile.yellow_cards_per_match)
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
    }:null,
    tendency:tendency(cards),
    sampleLabel:sampleLabel(matches),
    modelUse:'Referee history is used only in card-market analysis. It is one weighted input alongside recent team cards, home/away splits, season history, H2H and confirmed-XI card tendencies.',
  }),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
