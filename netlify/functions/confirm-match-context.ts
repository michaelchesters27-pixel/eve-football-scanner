import { createClient } from '@supabase/supabase-js'
import runExpandedMarkets from './run-expanded-markets'
import runCombos from './run-combos'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }
function clean(v:string){ return v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ') }
function slug(v:string){ return clean(v).replace(/ /g,'-') }
function json(data:any,status=200){ return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}}) }

export default async(request:Request)=>{
  if(request.method!=='POST') return json({ok:false,error:'POST required'},405)
  const origin=request.headers.get('origin')
  if(origin){
    try{
      if(new URL(origin).hostname!==new URL(request.url).hostname) return json({ok:false,error:'Same-origin request required'},403)
    }catch{ return json({ok:false,error:'Invalid origin'},403) }
  }

  let body:any
  try{ body=await request.json() }catch{ return json({ok:false,error:'Invalid JSON'},400) }
  const fixtureId=String(body?.fixtureId ?? '')
  const refereeName=String(body?.refereeName ?? '').trim()
  const homeNames=(Array.isArray(body?.homeLineup)?body.homeLineup:[]).map((x:any)=>String(x).trim()).filter(Boolean).slice(0,15)
  const awayNames=(Array.isArray(body?.awayLineup)?body.awayLineup:[]).map((x:any)=>String(x).trim()).filter(Boolean).slice(0,15)
  if(!fixtureId) return json({ok:false,error:'fixtureId is required'},400)

  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:fixture,error:fixtureError}=await supabase.from('fixtures').select('id,home_team_id,away_team_id,kickoff,status').eq('id',fixtureId).maybeSingle()
  if(fixtureError||!fixture) return json({ok:false,error:fixtureError?.message ?? 'Fixture not found'},404)
  if(!['scheduled','live'].includes(fixture.status)) return json({ok:false,error:'Fixture is no longer available for pre-match confirmation'},409)

  let refereeId:string|null=null
  if(refereeName){
    const sourceKey=`manual-ref:${slug(refereeName)}`
    const {data:ref,error}=await supabase.from('referees').upsert({source_key:sourceKey,name:refereeName},{onConflict:'source_key'}).select('id').single()
    if(error) return json({ok:false,error:error.message},500)
    refereeId=ref.id
    await supabase.from('fixtures').update({referee_id:refereeId,updated_at:new Date().toISOString()}).eq('id',fixtureId)
  }

  const teamIds=[fixture.home_team_id,fixture.away_team_id]
  const {data:existingPlayers}=await supabase.from('players').select('id,name,current_team_id,source,source_player_id').in('current_team_id',teamIds)
  const cache=new Map<string,string>()
  for(const p of existingPlayers??[]) cache.set(`${p.current_team_id}:${clean(p.name)}`,p.id)

  async function resolvePlayer(teamId:string,name:string){
    const k=`${teamId}:${clean(name)}`
    const found=cache.get(k)
    if(found) return found
    const sourcePlayerId=`${teamId}:${slug(name)}`
    const {data,error}=await supabase.from('players').upsert({source:'manual',source_player_id:sourcePlayerId,name,current_team_id:teamId,updated_at:new Date().toISOString()},{onConflict:'source,source_player_id'}).select('id').single()
    if(error) throw error
    cache.set(k,data.id)
    return data.id as string
  }

  const lineupsConfirmed=homeNames.length===11 && awayNames.length===11
  if(homeNames.length||awayNames.length){
    await supabase.from('fixture_lineups').delete().eq('fixture_id',fixtureId).eq('source','manual')
    const rows:any[]=[]
    for(const name of homeNames) rows.push({fixture_id:fixtureId,team_id:fixture.home_team_id,player_id:await resolvePlayer(fixture.home_team_id,name),is_starting:true,source:'manual',confirmed_at:new Date().toISOString()})
    for(const name of awayNames) rows.push({fixture_id:fixtureId,team_id:fixture.away_team_id,player_id:await resolvePlayer(fixture.away_team_id,name),is_starting:true,source:'manual',confirmed_at:new Date().toISOString()})
    if(rows.length){ const {error}=await supabase.from('fixture_lineups').insert(rows); if(error) return json({ok:false,error:error.message},500) }
  }

  const {error:contextError}=await supabase.from('manual_match_context').upsert({
    fixture_id:fixtureId,
    referee_name:refereeName||null,
    referee_confirmed:Boolean(refereeName),
    lineups_confirmed:lineupsConfirmed,
    notes:String(body?.notes ?? '').trim()||null,
    confirmed_at:new Date().toISOString(),
    updated_at:new Date().toISOString(),
  },{onConflict:'fixture_id'})
  if(contextError) return json({ok:false,error:contextError.message},500)

  // Re-run only this fixture immediately. No waiting for the morning schedule.
  const u=new URL(request.url)
  u.pathname='/.netlify/functions/run-expanded-now'
  u.search=`?fixture_id=${encodeURIComponent(fixtureId)}`
  let expanded:any=null,combo:any=null
  try{ expanded=await (await runExpandedMarkets(new Request(u.toString()))).json() }catch(e){ expanded={ok:false,error:e instanceof Error?e.message:String(e)} }
  try{ combo=await (await runCombos(new Request(u.toString()))).json() }catch(e){ combo={ok:false,error:e instanceof Error?e.message:String(e)} }

  return json({
    ok:true,
    fixtureId,
    refereeConfirmed:Boolean(refereeName),
    lineupsConfirmed,
    homePlayers:homeNames.length,
    awayPlayers:awayNames.length,
    expanded,
    combo,
    message:lineupsConfirmed?'Referee/starting XI saved and EVE re-analysed the match.':'Saved. Enter exactly 11 players for each team to mark the starting XIs as confirmed.',
  })
}
