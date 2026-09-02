import { createClient } from '@supabase/supabase-js'
import { loadFixturePlayerHistory } from './_shared/player-history'
import { loadConfirmedStarterFormCache } from './_shared/player-form-cache'
import runCoreScanner from './run-scanner'
import runExpandedMarkets from './run-expanded-markets'
import applyCoreCalibration from './apply-calibration'
import applyExpandedCalibration from './apply-expanded-calibration'
import runCombos from './run-combos'
import { refineFixtureRefereeIntelligence } from './refine-referee-intelligence'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }
function clean(v:string){ return v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ') }

async function relinkManualPlayers(supabase:ReturnType<typeof createClient>,fixtureId:string){
  const {data:fixture}=await supabase.from('fixtures').select('home_team_id,away_team_id').eq('id',fixtureId).maybeSingle()
  if(!fixture) return {relinked:0}
  const teamIds=[fixture.home_team_id,fixture.away_team_id]
  const {data:lineups}=await supabase.from('fixture_lineups').select('id,team_id,player_id').eq('fixture_id',fixtureId).eq('source','manual')
  const playerIds=[...new Set((lineups??[]).map((x:any)=>x.player_id))]
  if(!playerIds.length) return {relinked:0}

  const [{data:manualPlayers},{data:fotmobPlayers}]=await Promise.all([
    supabase.from('players').select('id,name').in('id',playerIds),
    supabase.from('players').select('id,name,current_team_id').eq('source','fotmob').in('current_team_id',teamIds),
  ])
  const manualName=new Map((manualPlayers??[]).map((p:any)=>[p.id,clean(p.name)]))
  const fotmobByTeamName=new Map((fotmobPlayers??[]).map((p:any)=>[`${p.current_team_id}:${clean(p.name)}`,p.id]))
  let relinked=0
  for(const row of lineups??[]){
    const name=manualName.get(row.player_id)
    if(!name) continue
    const canonical=fotmobByTeamName.get(`${row.team_id}:${name}`)
    if(!canonical||canonical===row.player_id) continue
    const {error}=await supabase.from('fixture_lineups').update({player_id:canonical}).eq('id',row.id)
    if(!error) relinked+=1
  }
  return {relinked}
}

async function ensureCoreSnapshots(supabase:ReturnType<typeof createClient>,fixtureId:string){
  const {count,error}=await supabase.from('feature_snapshots').select('id',{count:'exact',head:true}).eq('fixture_id',fixtureId).eq('model_version','v0-research').in('selection_key',['home_cards_1_5','away_cards_1_5'])
  if(error) throw error
  if(Number(count??0)>=2) return {needed:false,generated:null}
  // This edge case is rare: a fixture can arrive after the daily core run. Run the
  // DB-only scanner once so matchday referee intelligence never has "nothing to
  // refine". No Odds API credits are consumed by this scanner run.
  const response=await runCoreScanner()
  if(!response.ok) throw new Error(`Core scanner bootstrap failed: ${await response.text()}`)
  return {needed:true,generated:await response.json()}
}

export default async(request:Request)=>{
  const fixtureId=new URL(request.url).searchParams.get('fixture_id')
  if(!fixtureId) throw new Error('fixture_id is required')
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})

  const startedAt=new Date().toISOString()
  const u=new URL(request.url)
  u.search=`?fixture_id=${encodeURIComponent(fixtureId)}`

  const sync=await loadFixturePlayerHistory(supabase,fixtureId,10)
  const relink=await relinkManualPlayers(supabase,fixtureId)
  const formCache=await loadConfirmedStarterFormCache(supabase,fixtureId,10)
  const coreBootstrap=await ensureCoreSnapshots(supabase,fixtureId)

  const expandedResponse=await runExpandedMarkets(new Request(u.toString()))
  if(!expandedResponse.ok) throw new Error(`Expanded re-analysis failed: ${await expandedResponse.text()}`)
  const expanded=await expandedResponse.json()

  const refereeRefinement=await refineFixtureRefereeIntelligence(supabase,fixtureId)

  const coreCalibrationResponse=await applyCoreCalibration()
  if(!coreCalibrationResponse.ok) throw new Error(`Core calibration refresh failed: ${await coreCalibrationResponse.text()}`)
  const coreCalibration=await coreCalibrationResponse.json()

  const expandedCalibrationResponse=await applyExpandedCalibration()
  if(!expandedCalibrationResponse.ok) throw new Error(`Expanded calibration refresh failed: ${await expandedCalibrationResponse.text()}`)
  const expandedCalibration=await expandedCalibrationResponse.json()

  const comboResponse=await runCombos(new Request(u.toString()))
  if(!comboResponse.ok) throw new Error(`Combo refresh failed: ${await comboResponse.text()}`)
  const combo=await comboResponse.json()

  const status=formCache.setupRequired?'partial':'success'
  await supabase.from('source_sync_runs').insert({
    source:'eve-player-intelligence',
    job_name:'lineup-history-enrichment',
    status,
    rows_upserted:Number(sync?.stats??0)+Number(formCache?.cachedPlayers??0)+Number(refereeRefinement?.refined??0),
    started_at:startedAt,
    finished_at:new Date().toISOString(),
    error_message:JSON.stringify({
      fixtureId,
      mappedHistory:sync,
      formCache,
      relink,
      coreBootstrap,
      refereeRefinement,
      expanded,
      coreCalibrationPublished:coreCalibration?.totalPublished??null,
      expandedCalibrationPublished:expandedCalibration?.totalPublished??null,
      comboWritten:combo?.written??null,
      rule:'Confirmed referee intelligence and XI form are applied before final calibrated publication. XI form needs at least 5 appearances; referee history needs at least 3 appointments.',
    }).slice(0,5000),
  })
}
