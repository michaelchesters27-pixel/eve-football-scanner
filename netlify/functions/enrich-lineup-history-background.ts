import { createClient } from '@supabase/supabase-js'
import { loadFixturePlayerHistory } from './_shared/player-history'
import runExpandedMarkets from './run-expanded-markets'
import applyExpandedCalibration from './apply-expanded-calibration'
import runCombos from './run-combos'

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

export default async(request:Request)=>{
  const fixtureId=new URL(request.url).searchParams.get('fixture_id')
  if(!fixtureId) throw new Error('fixture_id is required')
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})

  const u=new URL(request.url)
  u.search=`?fixture_id=${encodeURIComponent(fixtureId)}`

  const sync=await loadFixturePlayerHistory(supabase,fixtureId,10)
  const relink=await relinkManualPlayers(supabase,fixtureId)

  const expandedResponse=await runExpandedMarkets(new Request(u.toString()))
  if(!expandedResponse.ok) throw new Error(`Expanded re-analysis failed: ${await expandedResponse.text()}`)
  const expanded=await expandedResponse.json()

  const calibrationResponse=await applyExpandedCalibration()
  if(!calibrationResponse.ok) throw new Error(`Calibration refresh failed: ${await calibrationResponse.text()}`)
  const calibration=await calibrationResponse.json()

  const comboResponse=await runCombos(new Request(u.toString()))
  if(!comboResponse.ok) throw new Error(`Combo refresh failed: ${await comboResponse.text()}`)
  const combo=await comboResponse.json()

  await supabase.from('source_sync_runs').insert({
    source:'eve-player-intelligence',
    job_name:'lineup-history-enrichment',
    status:'success',
    rows_upserted:Number(sync?.stats??0),
    started_at:new Date().toISOString(),
    finished_at:new Date().toISOString(),
    error_message:JSON.stringify({fixtureId,sync,relink,expanded,calibrationPublished:calibration?.totalPublished??null,comboWritten:combo?.written??null}).slice(0,5000),
  })
}
