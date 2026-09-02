import { createClient } from '@supabase/supabase-js'
import { buildRefereeIntelligence } from './_shared/referee-intelligence'

const LOOKBACK_MS=3*60*60*1000
const LOOKAHEAD_MS=7*24*60*60*1000
const MODEL_FRESH_MS=2*60*60*1000

function env(name:string){const value=process.env[name];if(!value) throw new Error(`Missing required environment variable: ${name}`);return value}
function clean(value:any){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
function sameName(a:any,b:any){const aa=clean(a),bb=clean(b);return Boolean(aa&&bb&&aa===bb)}
function chunks<T>(items:T[],size=80){const out:T[][]=[];for(let i=0;i<items.length;i+=size)out.push(items.slice(i,i+size));return out}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),nowMs=now.getTime(),from=new Date(nowMs-LOOKBACK_MS),to=new Date(nowMs+LOOKAHEAD_MS)
  const {data:fixtures,error:fixtureError}=await supabase.from('fixtures')
    .select('id,kickoff,status,referee_id,home_team_id,away_team_id')
    .in('status',['scheduled','live'])
    .gte('kickoff',from.toISOString())
    .lte('kickoff',to.toISOString())
    .order('kickoff',{ascending:true})
  if(fixtureError) throw fixtureError
  const fixtureRows=fixtures??[]
  const fixtureIds=fixtureRows.map((f:any)=>f.id)

  const contexts:any[]=[],predictions:any[]=[],snapshots:any[]=[],combos:any[]=[]
  for(const batch of chunks(fixtureIds)){
    const [ctx,pred,snap,combo]=await Promise.all([
      supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed,lineups_confirmed,confirmed_at,updated_at').in('fixture_id',batch),
      supabase.from('predictions').select('id,fixture_id,feature_snapshot_id,market,selection,confidence,grade,data_quality,fair_probability,model_version,publish_status,generated_at').in('fixture_id',batch).in('model_version',['v0-research','v1-expanded-research']),
      supabase.from('feature_snapshots').select('id,fixture_id,model_version,selection_key,features,calculated_at').in('fixture_id',batch).in('model_version',['v0-research','v1-expanded-research']),
      supabase.from('combo_recommendations').select('id,fixture_id,model_version,calculated_at').in('fixture_id',batch).eq('model_version','v1-combo-research'),
    ])
    for(const result of [ctx,pred,snap,combo]) if(result.error) throw result.error
    contexts.push(...(ctx.data??[]));predictions.push(...(pred.data??[]));snapshots.push(...(snap.data??[]));combos.push(...(combo.data??[]))
  }

  const activeRefIds=[...new Set(fixtureRows.map((f:any)=>f.referee_id).filter(Boolean))] as string[]
  const refs:any[]=[],profiles:any[]=[]
  for(const batch of chunks(activeRefIds)){
    const [refRows,profileRows]=await Promise.all([
      supabase.from('referees').select('id,name,source_key').in('id',batch),
      supabase.from('referee_profiles').select('referee_id,as_of_date,matches_sample,yellow_cards_per_match,red_cards_per_match,fouls_per_match,penalties_per_match,home_yellows_per_match,away_yellows_per_match,source').in('referee_id',batch),
    ])
    if(refRows.error) throw refRows.error
    if(profileRows.error) throw profileRows.error
    refs.push(...(refRows.data??[]));profiles.push(...(profileRows.data??[]))
  }
  const contextMap=new Map(contexts.map((x:any)=>[x.fixture_id,x]))
  const refMap=new Map(refs.map((x:any)=>[x.id,x]))
  const latestProfile=new Map<string,any>()
  for(const row of profiles){
    const prev=latestProfile.get(row.referee_id)
    if(!prev||String(row.as_of_date)>String(prev.as_of_date)||(String(row.as_of_date)===String(prev.as_of_date)&&Number(row.matches_sample)>Number(prev.matches_sample))) latestProfile.set(row.referee_id,row)
  }
  const snapByFixture=new Map<string,any[]>()
  for(const row of snapshots){const list=snapByFixture.get(row.fixture_id)??[];list.push(row);snapByFixture.set(row.fixture_id,list)}

  const hardViolations:any[]=[]
  const fixtureEvidence:any[]=[]
  for(const fixture of fixtureRows as any[]){
    const context=contextMap.get(fixture.id)??{}
    const confirmed=Boolean(context.referee_confirmed&&String(context.referee_name??'').trim())
    const linked=fixture.referee_id?refMap.get(fixture.referee_id):null
    const profile=fixture.referee_id?latestProfile.get(fixture.referee_id):null
    const intel=buildRefereeIntelligence(profile,'match')
    const cardSnaps=(snapByFixture.get(fixture.id)??[]).filter((s:any)=>['home_cards_1_5','away_cards_1_5','match_cards_3_5'].includes(s.selection_key))
    const refined=cardSnaps.filter((s:any)=>Boolean(s.features?.refereeIntelligence?.usable)).length
    const violations:string[]=[]
    if(confirmed&&!fixture.referee_id) violations.push('confirmed_referee_missing_link')
    if(confirmed&&fixture.referee_id&&!linked) violations.push('linked_referee_record_missing')
    if(confirmed&&linked&&!sameName(context.referee_name,linked.name)) violations.push('confirmed_referee_name_mismatch')
    if(confirmed&&!intel.usable) violations.push('confirmed_referee_missing_usable_profile')
    if(!confirmed&&fixture.referee_id) violations.push('unconfirmed_referee_still_linked')
    if(!confirmed&&refined>0) violations.push('unconfirmed_referee_influences_card_model')
    if(confirmed&&intel.usable&&cardSnaps.length>0&&refined!==cardSnaps.length) violations.push('confirmed_referee_not_propagated_to_all_card_snapshots')
    for(const type of violations) hardViolations.push({type,fixtureId:fixture.id,kickoff:fixture.kickoff,officialReferee:context.referee_name??null,linkedReferee:linked?.name??null})
    fixtureEvidence.push({fixtureId:fixture.id,kickoff:fixture.kickoff,refereeConfirmed:confirmed,refereeId:fixture.referee_id??null,sourceKey:linked?.source_key??null,profileSample:Number(profile?.matches_sample??0),cardSnapshots:cardSnaps.length,refereeRefined:refined})
  }

  const fixtureMap=new Map(fixtureRows.map((f:any)=>[f.id,f]))
  for(const p of predictions){
    const fixture:any=fixtureMap.get(p.fixture_id)
    if(!fixture||fixture.status!=='scheduled'||Date.parse(fixture.kickoff)<=nowMs) continue
    if(p.publish_status==='published'&&p.fair_probability==null) hardViolations.push({type:'upcoming_published_prediction_missing_calibration',predictionId:p.id,fixtureId:p.fixture_id,model:p.model_version,selection:p.selection})
    if(p.publish_status==='published'&&Date.parse(p.generated_at)<nowMs-MODEL_FRESH_MS) hardViolations.push({type:'upcoming_published_prediction_stale',predictionId:p.id,fixtureId:p.fixture_id,model:p.model_version,generatedAt:p.generated_at})
  }

  const [bestResult,expandedResult,stateResult]=await Promise.all([
    supabase.from('scanner_best_bets').select('id,fixtureId,kickoffUtc,fairProbability'),
    supabase.from('scanner_expanded_markets').select('id,fixtureId,kickoffUtc,fairProbability'),
    supabase.from('scanner_publication_state').select('surface,refreshed_at,row_count').in('surface',['best_bets','market_lab']),
  ])
  if(bestResult.error) throw bestResult.error
  if(expandedResult.error) throw expandedResult.error
  if(stateResult.error) throw stateResult.error
  const bestBets=bestResult.data??[]
  const expandedMarkets=expandedResult.data??[]
  const publicationState=new Map((stateResult.data??[]).map((x:any)=>[x.surface,x]))

  for(const row of bestBets){
    if(Date.parse((row as any).kickoffUtc)<=nowMs) hardViolations.push({type:'best_bets_view_contains_started_fixture',predictionId:(row as any).id,fixtureId:(row as any).fixtureId,kickoff:(row as any).kickoffUtc})
    if((row as any).fairProbability==null) hardViolations.push({type:'best_bets_view_contains_uncalibrated_selection',predictionId:(row as any).id,fixtureId:(row as any).fixtureId})
  }
  for(const row of expandedMarkets){
    if(Date.parse((row as any).kickoffUtc)<=nowMs) hardViolations.push({type:'market_lab_view_contains_started_fixture',predictionId:(row as any).id,fixtureId:(row as any).fixtureId,kickoff:(row as any).kickoffUtc})
    if((row as any).fairProbability==null) hardViolations.push({type:'market_lab_view_contains_uncalibrated_selection',predictionId:(row as any).id,fixtureId:(row as any).fixtureId})
  }
  for(const surface of ['best_bets','market_lab']){
    const state:any=publicationState.get(surface)
    if(!state){hardViolations.push({type:'publication_state_missing',surface});continue}
    if(Date.parse(state.refreshed_at)<nowMs-MODEL_FRESH_MS) hardViolations.push({type:'publication_state_stale',surface,refreshedAt:state.refreshed_at,rowCount:state.row_count})
    const visibleCount=surface==='best_bets'?bestBets.length:expandedMarkets.length
    if(visibleCount>Number(state.row_count??0)) hardViolations.push({type:'public_surface_exceeds_published_snapshot',surface,visibleCount,publishedCount:state.row_count})
  }

  for(const combo of combos){
    const fixture:any=fixtureMap.get(combo.fixture_id)
    if(!fixture||fixture.status!=='scheduled'||Date.parse(fixture.kickoff)<=nowMs) continue
    if(Date.parse(combo.calculated_at)<nowMs-MODEL_FRESH_MS) hardViolations.push({type:'upcoming_combo_stale',comboId:combo.id,fixtureId:combo.fixture_id,calculatedAt:combo.calculated_at})
  }

  const confirmedLineupFixtures=fixtureRows.filter((f:any)=>Boolean(contextMap.get(f.id)?.lineups_confirmed))
  for(const fixture of confirmedLineupFixtures as any[]){
    const {data:rows,error}=await supabase.from('fixture_lineups').select('team_id,source,confirmed_at').eq('fixture_id',fixture.id).eq('is_starting',true)
    if(error) throw error
    const lineupRows=rows??[]
    const home=lineupRows.filter((r:any)=>r.team_id===fixture.home_team_id).length
    const away=lineupRows.filter((r:any)=>r.team_id===fixture.away_team_id).length
    const manual=lineupRows.some((r:any)=>r.source==='manual')
    const fotmobTimes=lineupRows.filter((r:any)=>r.source==='fotmob'&&r.confirmed_at).map((r:any)=>Date.parse(r.confirmed_at)).filter(Number.isFinite)
    const latestFotmob=fotmobTimes.length?Math.max(...fotmobTimes):NaN
    const tooEarly=fixture.status==='scheduled'&&!manual&&Number.isFinite(latestFotmob)&&(Date.parse(fixture.kickoff)-latestFotmob)>90*60*1000
    if(home!==11||away!==11) hardViolations.push({type:'confirmed_lineup_not_11_plus_11',fixtureId:fixture.id,homeStarters:home,awayStarters:away})
    if(tooEarly) hardViolations.push({type:'fotmob_lineup_confirmed_too_early',fixtureId:fixture.id,kickoff:fixture.kickoff,confirmedAt:new Date(latestFotmob).toISOString()})
  }

  const duplicateIndex=new Map<string,any[]>()
  for(const ref of refs){const key=clean(ref.name);if(!key)continue;const list=duplicateIndex.get(key)??[];list.push(ref);duplicateIndex.set(key,list)}
  const activeDuplicateNames=[...duplicateIndex.entries()].filter(([,rows])=>rows.length>1).map(([name,rows])=>({name,rows:rows.map((r:any)=>({id:r.id,name:r.name,sourceKey:r.source_key}))}))
  for(const duplicate of activeDuplicateNames) hardViolations.push({type:'duplicate_active_referee_identity',...duplicate})

  const {data:overdueResults,error:resultError}=await supabase.from('scanner_result_log')
    .select('id,sourcePage,outcome,kickoffUtc')
    .eq('sourcePage','best_bets')
    .eq('outcome','pending')
    .lt('kickoffUtc',new Date(nowMs-4*60*60*1000).toISOString())
  if(resultError) throw resultError
  for(const row of overdueResults??[]) hardViolations.push({type:'finished_best_bet_still_pending',resultId:(row as any).id,kickoff:(row as any).kickoffUtc})

  const auditPass=hardViolations.length===0
  const summary={
    checkedAt:new Date().toISOString(),
    universe:{lookbackHours:3,lookaheadDays:7,fixtures:fixtureRows.length,noFixtureCap:true},
    predictions:predictions.length,snapshots:snapshots.length,combos:combos.length,
    bestBetsVisible:bestBets.length,
    marketLabVisible:expandedMarkets.length,
    publicationState:Object.fromEntries(publicationState),
    confirmedReferees:fixtureEvidence.filter((x:any)=>x.refereeConfirmed).length,
    activeRefereeIds:activeRefIds.length,
    activeDuplicateNames:activeDuplicateNames.length,
    confirmedLineups:confirmedLineupFixtures.length,
    overduePendingBestBets:(overdueResults??[]).length,
    hardViolationCount:hardViolations.length,
  }

  return new Response(JSON.stringify({ok:auditPass,auditPass,summary,hardViolations,activeDuplicateNames,fixtures:fixtureEvidence}),{
    status:auditPass?200:500,
    headers:{'content-type':'application/json','cache-control':'no-store'},
  })
}
