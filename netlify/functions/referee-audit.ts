import { createClient } from '@supabase/supabase-js'
import { buildRefereeIntelligence, loadBestRefereeProfile } from './_shared/referee-intelligence'

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function present(value:any){return value!=null&&value!==''&&Number.isFinite(Number(value))}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),horizon=new Date(now.getTime()+7*86400000)
  const {data:fixtures,error}=await supabase.from('fixtures')
    .select('id,kickoff,status,referee_id,home_team_id,away_team_id')
    .in('status',['scheduled','live'])
    .gte('kickoff',new Date(now.getTime()-3*3600000).toISOString())
    .lte('kickoff',horizon.toISOString())
    .order('kickoff',{ascending:true}).limit(100)
  if(error) return new Response(JSON.stringify({ok:false,error:error.message}),{status:500,headers:{'content-type':'application/json'}})
  const ids=(fixtures??[]).map((f:any)=>f.id),refIds=[...new Set((fixtures??[]).map((f:any)=>f.referee_id).filter(Boolean))]
  const teamIds=[...new Set((fixtures??[]).flatMap((f:any)=>[f.home_team_id,f.away_team_id]))]
  const [{data:contexts},{data:refs},{data:teams},{data:snapshots},{data:runs}]=await Promise.all([
    ids.length?supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed').in('fixture_id',ids):Promise.resolve({data:[] as any[]}),
    refIds.length?supabase.from('referees').select('id,name,source_key').in('id',refIds):Promise.resolve({data:[] as any[]}),
    teamIds.length?supabase.from('teams').select('id,name').in('id',teamIds):Promise.resolve({data:[] as any[]}),
    ids.length?supabase.from('feature_snapshots').select('fixture_id,model_version,selection_key,features,evidence,calculated_at').in('fixture_id',ids).in('model_version',['v0-research','v1-expanded-research']).in('selection_key',['home_cards_1_5','away_cards_1_5','match_cards_3_5']):Promise.resolve({data:[] as any[]}),
    supabase.from('source_sync_runs').select('job_name,started_at,finished_at,status,error_message').in('job_name',['matchday-auto-sync','reconcile-referees']).order('started_at',{ascending:false}).limit(10),
  ])
  const contextMap=new Map((contexts??[]).map((x:any)=>[x.fixture_id,x])),refMap=new Map((refs??[]).map((x:any)=>[x.id,x])),teamMap=new Map((teams??[]).map((x:any)=>[x.id,x.name]))
  const snapshotMap=new Map<string,any[]>()
  for(const row of snapshots??[]){const arr=snapshotMap.get(row.fixture_id)??[];arr.push(row);snapshotMap.set(row.fixture_id,arr)}

  const details:any[]=[]
  for(const fixture of fixtures??[]){
    const context=contextMap.get(fixture.id)??{}
    let profile:any=null,intel:any=null,profileError:string|null=null
    if(fixture.referee_id){try{profile=await loadBestRefereeProfile(supabase,fixture.referee_id);intel=buildRefereeIntelligence(profile,'match')}catch(e){profileError=e instanceof Error?e.message:String(e)}}
    const cards=snapshotMap.get(fixture.id)??[]
    const core=cards.filter((x:any)=>x.model_version==='v0-research')
    const expanded=cards.filter((x:any)=>x.model_version==='v1-expanded-research')
    const refined=(row:any)=>Boolean(row?.features?.refereeIntelligence?.usable)
    details.push({
      fixtureId:fixture.id,kickoff:fixture.kickoff,homeTeam:teamMap.get(fixture.home_team_id)??fixture.home_team_id,awayTeam:teamMap.get(fixture.away_team_id)??fixture.away_team_id,
      refereeConfirmed:Boolean(context.referee_confirmed),officialReferee:context.referee_name??null,linkedReferee:refMap.get(fixture.referee_id)?.name??null,refereeId:fixture.referee_id??null,
      profileUsable:Boolean(intel?.usable),sample:intel?.sample??0,modelScore:intel?.score??null,reliabilityPct:intel?.reliabilityPct??null,profileError,
      stats:profile?{yellow:profile.yellow_cards_per_match,red:profile.red_cards_per_match,fouls:profile.fouls_per_match,penalties:profile.penalties_per_match,homeYellows:profile.home_yellows_per_match,awayYellows:profile.away_yellows_per_match,sources:profile.sources??[profile.source]}:null,
      coreCardSnapshots:core.length,coreRefined:core.filter(refined).length,expandedCardSnapshots:expanded.length,expandedRefined:expanded.filter(refined).length,
    })
  }

  const usable=details.filter((x)=>x.profileUsable),confirmed=details.filter((x)=>x.refereeConfirmed),linked=details.filter((x)=>x.refereeId)
  const withStat=(key:string)=>usable.filter((x)=>present(x.stats?.[key])).length
  const summary={
    upcomingFixtures:details.length,refereeConfirmed:confirmed.length,refereeLinked:linked.length,usableProfiles:usable.length,
    statCoverage:{yellow:withStat('yellow'),red:withStat('red'),fouls:withStat('fouls'),penalties:withStat('penalties'),homeYellows:withStat('homeYellows'),awayYellows:withStat('awayYellows')},
    coreCardSnapshots:details.reduce((s,x)=>s+x.coreCardSnapshots,0),coreRefined:details.reduce((s,x)=>s+x.coreRefined,0),
    expandedCardSnapshots:details.reduce((s,x)=>s+x.expandedCardSnapshots,0),expandedRefined:details.reduce((s,x)=>s+x.expandedRefined,0),
  }
  return new Response(JSON.stringify({ok:true,checkedAt:new Date().toISOString(),summary,latestRuns:runs??[],fixtures:details}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
