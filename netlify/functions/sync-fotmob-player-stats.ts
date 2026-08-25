import { createClient } from '@supabase/supabase-js'

export const config = { schedule: '20 5 * * *' }

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }
function slug(v:string){ return v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'') }
function num(v:any){ const n=Number(typeof v==='object' && v ? (v.value ?? v.stat ?? v.total ?? NaN) : v); return Number.isFinite(n) ? n : null }
function key(v:any){ return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g,'') }

function findStat(node:any,aliases:string[]): number | null {
  if(node==null) return null
  const wanted=new Set(aliases.map(key))
  const visit=(value:any):number|null=>{
    if(value==null) return null
    if(Array.isArray(value)){
      for(const item of value){ const got=visit(item); if(got!=null) return got }
      return null
    }
    if(typeof value!=='object') return null
    for(const [k,v] of Object.entries(value)){
      if(wanted.has(key(k))){ const n=num(v); if(n!=null) return n }
      if(typeof v==='object'&&v){
        const title=(v as any).title ?? (v as any).name ?? (v as any).key
        if(title&&wanted.has(key(title))){ const n=num((v as any).value ?? (v as any).stat ?? (v as any).total); if(n!=null) return n }
      }
    }
    for(const v of Object.values(value)){ if(typeof v==='object'&&v){ const got=visit(v); if(got!=null) return got } }
    return null
  }
  return visit(node)
}

async function fetchDetails(matchId:string){
  const urls=[`https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,`https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`]
  let last='FotMob matchDetails failed'
  for(const url of urls){
    try{
      const r=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.5'}})
      if(!r.ok){ last=`${r.status} ${r.statusText}`; continue }
      const body=await r.json(); if(body?.content||body?.general) return body
    }catch(e){ last=e instanceof Error?e.message:String(e) }
  }
  throw new Error(last)
}

function allEvents(payload:any){
  const a=Array.isArray(payload?.header?.events)?payload.header.events:[]
  const b=Array.isArray(payload?.content?.matchFacts?.events?.events)?payload.content.matchFacts.events.events:[]
  return [...a,...b]
}
function eventCount(events:any[],playerId:string,typeWords:string[]){
  const wanted=typeWords.map(key)
  return events.filter((e)=>{
    const pid=String(e?.player?.id ?? e?.playerId ?? e?.player?.playerId ?? '')
    if(pid!==playerId) return false
    const type=key(e?.type ?? e?.eventType ?? e?.card ?? '')
    return wanted.some((w)=>type.includes(w))
  }).length
}

type FixtureRow={
  id:string
  source_fixture_id:string|null
  home_team_id:string
  away_team_id:string
  match_context:any
  kickoff:string
}

async function fixturesForRun(supabase:ReturnType<typeof createClient>,requestedFixtureId:string|null){
  if(!requestedFixtureId){
    const since=new Date(Date.now()-4*86400000).toISOString()
    const {data,error}=await supabase.from('fixtures')
      .select('id,source_fixture_id,home_team_id,away_team_id,match_context,kickoff')
      .eq('source','fotmob').eq('status','finished').gte('kickoff',since).order('kickoff',{ascending:false}).limit(80)
    if(error) throw error
    return {fixtures:(data??[]) as FixtureRow[],mode:'daily' as const,target:null}
  }

  const {data:target,error:targetError}=await supabase.from('fixtures')
    .select('id,kickoff,home_team_id,away_team_id')
    .eq('id',requestedFixtureId).maybeSingle()
  if(targetError||!target) throw new Error(targetError?.message ?? 'Target fixture not found')

  const found=new Map<string,FixtureRow>()
  for(const teamId of [target.home_team_id,target.away_team_id]){
    const {data,error}=await supabase.from('fixtures')
      .select('id,source_fixture_id,home_team_id,away_team_id,match_context,kickoff')
      .eq('source','fotmob').eq('status','finished').lt('kickoff',target.kickoff)
      .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
      .order('kickoff',{ascending:false}).limit(10)
    if(error) throw error
    for(const row of data??[]) found.set(row.id,row as FixtureRow)
  }
  const fixtures=[...found.values()].sort((a,b)=>Date.parse(b.kickoff)-Date.parse(a.kickoff)).slice(0,20)
  return {fixtures,mode:'targeted' as const,target}
}

export default async(request?:Request)=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const requestedFixtureId=request?new URL(request.url).searchParams.get('fixture_id'):null

  let selection
  try{ selection=await fixturesForRun(supabase,requestedFixtureId) }
  catch(e){ return new Response(JSON.stringify({ok:false,error:e instanceof Error?e.message:String(e)}),{status:500,headers:{'content-type':'application/json'}}) }

  let matches=0,playersWritten=0,statsWritten=0,lineupsWritten=0,refsWritten=0,skippedComplete=0
  const warnings:string[]=[]

  for(const fixture of selection.fixtures){
    try{
      const {count}=await supabase.from('player_match_stats').select('id',{count:'exact',head:true}).eq('fixture_id',fixture.id)
      if(Number(count??0)>=18){ skippedComplete+=1; continue }
      if(!fixture.source_fixture_id){ warnings.push(`${fixture.id}: missing FotMob source fixture id`); continue }

      const payload=await fetchDetails(String(fixture.source_fixture_id))
      const refereeRaw=payload?.content?.matchFacts?.infoBox?.Referee ?? payload?.content?.matchFacts?.infoBox?.referee ?? payload?.general?.referee
      const refereeName=typeof refereeRaw==='string'?refereeRaw:String(refereeRaw?.text ?? refereeRaw?.name ?? '').trim()
      if(refereeName){
        const sourceKey=`fotmob-ref:${slug(refereeName)}`
        const {data:ref,error:refError}=await supabase.from('referees').upsert({source_key:sourceKey,name:refereeName},{onConflict:'source_key'}).select('id').single()
        if(!refError&&ref?.id){ await supabase.from('fixtures').update({referee_id:ref.id,updated_at:new Date().toISOString()}).eq('id',fixture.id); refsWritten+=1 }
      }

      const lineups=payload?.content?.lineup?.lineups ?? payload?.content?.lineup2?.lineups ?? []
      const shotmap=payload?.content?.shotmap?.shots ?? []
      const events=allEvents(payload)
      const homeFotmob=String(fixture.match_context?.fotmob_home_team_id ?? '')
      const awayFotmob=String(fixture.match_context?.fotmob_away_team_id ?? '')

      for(const group of Array.isArray(lineups)?lineups:[]){
        const fotmobTeam=String(group?.teamId ?? group?.team?.id ?? '')
        const teamId=fotmobTeam===homeFotmob?fixture.home_team_id:fotmobTeam===awayFotmob?fixture.away_team_id:null
        if(!teamId) continue
        const groupPlayers=Array.isArray(group?.players)?group.players:[]
        for(let idx=0;idx<groupPlayers.length;idx+=1){
          const item=groupPlayers[idx]
          const p=item?.player ?? item
          const playerIdRaw=String(p?.id ?? p?.playerId ?? item?.id ?? '')
          const name=String(p?.name ?? p?.playerName ?? item?.name ?? '').trim()
          if(!name) continue
          const sourcePlayerId=playerIdRaw || `name:${teamId}:${slug(name)}`
          const position=String(p?.positionString ?? p?.position ?? item?.position ?? '').trim() || null
          const {data:player,error:playerError}=await supabase.from('players').upsert({source:'fotmob',source_player_id:sourcePlayerId,name,current_team_id:teamId,position,updated_at:new Date().toISOString()},{onConflict:'source,source_player_id'}).select('id').single()
          if(playerError||!player?.id){ warnings.push(`${fixture.source_fixture_id}:${name}: ${playerError?.message ?? 'player upsert failed'}`); continue }
          playersWritten+=1

          const explicitStarter=p?.isStarter ?? item?.isStarter ?? item?.starter
          const started=typeof explicitStarter==='boolean'?explicitStarter:idx<11
          if(started){
            const {error:lineupError}=await supabase.from('fixture_lineups').upsert({fixture_id:fixture.id,team_id:teamId,player_id:player.id,is_starting:true,shirt_number:num(p?.shirtNumber ?? item?.shirtNumber),position,source:'fotmob',confirmed_at:new Date().toISOString()},{onConflict:'fixture_id,player_id,source'})
            if(!lineupError) lineupsWritten+=1
          }

          const playerShots=(Array.isArray(shotmap)?shotmap:[]).filter((s:any)=>String(s?.playerId ?? s?.player?.id ?? '')===playerIdRaw)
          const shotCount=playerShots.length || findStat(p,['shots','total shots','shot attempts']) || findStat(item,['shots','total shots']) || 0
          const sotFromMap=playerShots.filter((s:any)=>Boolean(s?.isOnTarget) || ['goal','attemptsaved','saved'].some((w)=>key(s?.eventType ?? s?.type).includes(w))).length
          const sot=sotFromMap || findStat(p,['shots on target','shotsontarget','ontarget']) || findStat(item,['shots on target','shotsontarget']) || 0
          const goals=eventCount(events,playerIdRaw,['goal']) || findStat(p,['goals','goal']) || 0
          const assists=findStat(p,['assists','assist']) || findStat(item,['assists']) || 0
          const yellows=eventCount(events,playerIdRaw,['yellowcard','yellow']) || findStat(p,['yellow cards','yellowcards']) || 0
          const reds=eventCount(events,playerIdRaw,['redcard','red']) || findStat(p,['red cards','redcards']) || 0
          const minutes=findStat(p,['minutes played','minutes','mins']) ?? findStat(item,['minutes played','minutes'])
          const foulsCommitted=findStat(p,['fouls committed','fouls']) ?? findStat(item,['fouls committed'])
          const foulsWon=findStat(p,['fouls won','was fouled']) ?? findStat(item,['fouls won'])
          const xg=findStat(p,['expected goals','xg']) ?? findStat(item,['expected goals','xg'])
          const xa=findStat(p,['expected assists','xa']) ?? findStat(item,['expected assists','xa'])
          const {error:statError}=await supabase.from('player_match_stats').upsert({fixture_id:fixture.id,player_id:player.id,team_id:teamId,started,minutes,shots:shotCount,shots_on_target:sot,goals,assists,yellow_cards:yellows,red_cards:reds,fouls_committed:foulsCommitted,fouls_won:foulsWon,xg,xa,source:'fotmob'},{onConflict:'fixture_id,player_id'})
          if(!statError) statsWritten+=1
        }
      }
      matches+=1
    }catch(e){ warnings.push(`${fixture.source_fixture_id ?? fixture.id}: ${e instanceof Error?e.message:String(e)}`) }
    await new Promise((resolve)=>setTimeout(resolve,180))
  }

  return new Response(JSON.stringify({
    ok:true,
    mode:selection.mode,
    targetFixtureId:requestedFixtureId,
    candidateMatches:selection.fixtures.length,
    matches,
    skippedComplete,
    playersWritten,
    statsWritten,
    lineupsWritten,
    refsWritten,
    warnings:warnings.slice(0,30),
    note:selection.mode==='targeted'
      ? 'Loaded up to the previous 10 FotMob matches for each team so confirmed starters can be evaluated against compact prior player history.'
      : 'Daily player sync. FotMob matchDetails is an unofficial feed; EVE stores compact derived player stats only.',
  }),{headers:{'content-type':'application/json'}})
}
