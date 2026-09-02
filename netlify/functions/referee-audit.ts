import { createClient } from '@supabase/supabase-js'
import { buildRefereeIntelligence, loadBestRefereeProfile } from './_shared/referee-intelligence'

const LOOKBACK_MS=3*3600000
const LOOKAHEAD_MS=4*24*3600000
const MAX_FIXTURES=120

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function present(value:any){return value!=null&&value!==''&&Number.isFinite(Number(value))}
function clean(value:any){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
function sameName(a:any,b:any){const aa=clean(a),bb=clean(b);return Boolean(aa&&bb&&aa===bb)}
function hoursUntil(kickoff:string,nowMs:number){return (Date.parse(kickoff)-nowMs)/3600000}
function missingBucket(hours:number){
  if(hours<=0)return 'live_or_started'
  if(hours<=6)return 'under_6h'
  if(hours<=24)return '6_to_24h'
  if(hours<=48)return '24_to_48h'
  return '48_to_96h'
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),nowMs=now.getTime(),horizon=new Date(nowMs+LOOKAHEAD_MS),floor=new Date(nowMs-LOOKBACK_MS)
  const {data:fixtures,error}=await supabase.from('fixtures')
    .select('id,kickoff,status,referee_id,home_team_id,away_team_id')
    .in('status',['scheduled','live'])
    .gte('kickoff',floor.toISOString())
    .lte('kickoff',horizon.toISOString())
    .order('kickoff',{ascending:true}).limit(MAX_FIXTURES)
  if(error)return new Response(JSON.stringify({ok:false,error:error.message}),{status:500,headers:{'content-type':'application/json'}})

  const fixtureRows=fixtures??[]
  const ids=fixtureRows.map((f:any)=>f.id)
  const activeRefIds=[...new Set(fixtureRows.map((f:any)=>f.referee_id).filter(Boolean))]
  const teamIds=[...new Set(fixtureRows.flatMap((f:any)=>[f.home_team_id,f.away_team_id]))]
  const [{data:contexts},{data:allRefs},{data:teams},{data:snapshots},{data:runs}]=await Promise.all([
    ids.length?supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed,lineups_confirmed,confirmed_at,updated_at').in('fixture_id',ids):Promise.resolve({data:[] as any[]}),
    supabase.from('referees').select('id,name,source_key'),
    teamIds.length?supabase.from('teams').select('id,name').in('id',teamIds):Promise.resolve({data:[] as any[]}),
    ids.length?supabase.from('feature_snapshots').select('fixture_id,model_version,selection_key,features,evidence,calculated_at').in('fixture_id',ids).in('model_version',['v0-research','v1-expanded-research']).in('selection_key',['home_cards_1_5','away_cards_1_5','match_cards_3_5']):Promise.resolve({data:[] as any[]}),
    supabase.from('source_sync_runs').select('source,job_name,started_at,finished_at,status,rows_upserted,error_message').in('job_name',['hourly-pre-match-intelligence','hourly-referee-fallback','matchday-auto-sync','reconcile-referees']).order('started_at',{ascending:false}).limit(20),
  ])

  const contextMap=new Map((contexts??[]).map((x:any)=>[x.fixture_id,x]))
  const refMap=new Map((allRefs??[]).map((x:any)=>[x.id,x]))
  const teamMap=new Map((teams??[]).map((x:any)=>[x.id,x.name]))
  const snapshotMap=new Map<string,any[]>()
  for(const row of snapshots??[]){const arr=snapshotMap.get(row.fixture_id)??[];arr.push(row);snapshotMap.set(row.fixture_id,arr)}

  const duplicateIndex=new Map<string,any[]>()
  for(const ref of allRefs??[]){const key=clean(ref.name);if(!key)continue;const arr=duplicateIndex.get(key)??[];arr.push(ref);duplicateIndex.set(key,arr)}
  const activeDuplicateNames=[...duplicateIndex.entries()]
    .filter(([,rows])=>rows.length>1&&rows.some((r:any)=>activeRefIds.includes(r.id)))
    .map(([normalizedName,rows])=>({normalizedName,count:rows.length,rows:rows.map((r:any)=>({id:r.id,name:r.name,sourceKey:r.source_key,active:activeRefIds.includes(r.id)}))}))

  const details:any[]=[]
  for(const fixture of fixtureRows){
    const context=contextMap.get(fixture.id)??{}
    const linked=refMap.get(fixture.referee_id)
    let profile:any=null,intel:any=null,profileError:string|null=null
    if(fixture.referee_id){try{profile=await loadBestRefereeProfile(supabase,fixture.referee_id);intel=buildRefereeIntelligence(profile,'match')}catch(e){profileError=e instanceof Error?e.message:String(e)}}
    const cards=snapshotMap.get(fixture.id)??[]
    const core=cards.filter((x:any)=>x.model_version==='v0-research')
    const expanded=cards.filter((x:any)=>x.model_version==='v1-expanded-research')
    const refined=(row:any)=>Boolean(row?.features?.refereeIntelligence?.usable)
    const coreRefined=core.filter(refined).length,expandedRefined=expanded.filter(refined).length
    const confirmed=Boolean(context.referee_confirmed&&context.referee_name)
    const h=hoursUntil(fixture.kickoff,nowMs)
    const nameConsistent=!confirmed||Boolean(linked&&sameName(context.referee_name,linked.name))
    const sources=profile?.sources?.length?profile.sources:[profile?.source].filter(Boolean)
    const violations:string[]=[]
    if(confirmed&&!fixture.referee_id)violations.push('confirmed_missing_link')
    if(confirmed&&fixture.referee_id&&!nameConsistent)violations.push('confirmed_name_mismatch')
    if(confirmed&&!intel?.usable)violations.push('confirmed_missing_usable_profile')
    if(!confirmed&&fixture.referee_id)violations.push('unconfirmed_with_linked_referee')
    if(!confirmed&&(coreRefined>0||expandedRefined>0))violations.push('unconfirmed_referee_used_by_model')
    if(confirmed&&intel?.usable&&core.length>0&&coreRefined!==core.length)violations.push('core_referee_propagation_failure')
    if(confirmed&&intel?.usable&&expanded.length>0&&expandedRefined!==expanded.length)violations.push('expanded_referee_propagation_failure')
    details.push({
      fixtureId:fixture.id,kickoff:fixture.kickoff,hoursUntilKickoff:Math.round(h*10)/10,status:fixture.status,
      homeTeam:teamMap.get(fixture.home_team_id)??fixture.home_team_id,awayTeam:teamMap.get(fixture.away_team_id)??fixture.away_team_id,
      refereeConfirmed:confirmed,officialReferee:context.referee_name??null,linkedReferee:linked?.name??null,refereeId:fixture.referee_id??null,linkedSourceKey:linked?.source_key??null,nameConsistent,
      profileUsable:Boolean(intel?.usable),sample:intel?.sample??0,modelScore:intel?.score??null,reliabilityPct:intel?.reliabilityPct??null,profileAsOfDate:profile?.as_of_date??null,profileSources:sources,profileError,
      stats:profile?{yellow:profile.yellow_cards_per_match,red:profile.red_cards_per_match,fouls:profile.fouls_per_match,penalties:profile.penalties_per_match,homeYellows:profile.home_yellows_per_match,awayYellows:profile.away_yellows_per_match}:null,
      coreCardSnapshots:core.length,coreRefined,expandedCardSnapshots:expanded.length,expandedRefined,violations,
    })
  }

  const confirmed=details.filter((x)=>x.refereeConfirmed),linked=details.filter((x)=>x.refereeId),usable=details.filter((x)=>x.profileUsable)
  const missing=details.filter((x)=>!x.refereeConfirmed)
  const withStat=(key:string)=>usable.filter((x)=>present(x.stats?.[key])).length
  const missingByWindow={live_or_started:0,under_6h:0,'6_to_24h':0,'24_to_48h':0,'48_to_96h':0} as Record<string,number>
  for(const row of missing)missingByWindow[missingBucket(row.hoursUntilKickoff)]=(missingByWindow[missingBucket(row.hoursUntilKickoff)]??0)+1
  const nearTermMissing=missing.filter((x)=>x.hoursUntilKickoff<=24).map((x)=>({fixtureId:x.fixtureId,kickoff:x.kickoff,hoursUntilKickoff:x.hoursUntilKickoff,homeTeam:x.homeTeam,awayTeam:x.awayTeam}))
  const hardViolations=details.flatMap((x)=>x.violations.map((type:string)=>({type,fixtureId:x.fixtureId,kickoff:x.kickoff,homeTeam:x.homeTeam,awayTeam:x.awayTeam,officialReferee:x.officialReferee,linkedReferee:x.linkedReferee})))
  const profileSourceCoverage={
    fotmobMatchDetails:usable.filter((x)=>x.profileSources.includes('fotmob-match-details')).length,
    fotmobRefereePage:usable.filter((x)=>x.profileSources.includes('fotmob-referee-page')).length,
    eveDerived:usable.filter((x)=>x.profileSources.includes('eve-derived')).length,
    footballData:usable.filter((x)=>x.profileSources.some((s:string)=>s.includes('football-data'))).length,
  }
  const modeledWithConfirmedProfile=details.filter((x)=>x.refereeConfirmed&&x.profileUsable&&(x.coreCardSnapshots>0||x.expandedCardSnapshots>0))
  const summary={
    auditScope:{lookbackHours:3,lookaheadHours:96,maxFixtures:MAX_FIXTURES,fixtureLimitReached:fixtureRows.length===MAX_FIXTURES},
    actionableFixtures:details.length,refereeConfirmed:confirmed.length,refereeLinked:linked.length,usableProfiles:usable.length,missingReferee:missing.length,missingByWindow,nearTermMissingUnder24h:nearTermMissing.length,
    statCoverage:{yellow:withStat('yellow'),red:withStat('red'),fouls:withStat('fouls'),penalties:withStat('penalties'),homeYellows:withStat('homeYellows'),awayYellows:withStat('awayYellows')},
    profileSourceCoverage,activeDuplicateNames:activeDuplicateNames.length,
    coreCardSnapshots:details.reduce((s,x)=>s+x.coreCardSnapshots,0),coreRefined:details.reduce((s,x)=>s+x.coreRefined,0),
    expandedCardSnapshots:details.reduce((s,x)=>s+x.expandedCardSnapshots,0),expandedRefined:details.reduce((s,x)=>s+x.expandedRefined,0),modeledWithConfirmedProfile:modeledWithConfirmedProfile.length,
    hardViolationCount:hardViolations.length,
    invariants:{
      everyConfirmedRefereeLinked:confirmed.every((x)=>Boolean(x.refereeId)),
      everyConfirmedRefereeHasUsableProfile:confirmed.every((x)=>x.profileUsable),
      everyConfirmedLinkMatchesOfficialName:confirmed.every((x)=>x.nameConsistent),
      noUnconfirmedRefereeUsedByModel:details.every((x)=>!x.violations.includes('unconfirmed_referee_used_by_model')),
      everyEligibleCoreCardSnapshotRefined:details.every((x)=>!(x.refereeConfirmed&&x.profileUsable&&x.coreCardSnapshots>0)||x.coreRefined===x.coreCardSnapshots),
      everyEligibleExpandedCardSnapshotRefined:details.every((x)=>!(x.refereeConfirmed&&x.profileUsable&&x.expandedCardSnapshots>0)||x.expandedRefined===x.expandedCardSnapshots),
    },
  }
  const auditPass=hardViolations.length===0&&missingByWindow.under_6h===0&&missingByWindow.live_or_started===0
  return new Response(JSON.stringify({ok:true,auditPass,checkedAt:new Date().toISOString(),summary,hardViolations,nearTermMissing,activeDuplicateNames,latestRuns:runs??[],fixtures:details}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
}
