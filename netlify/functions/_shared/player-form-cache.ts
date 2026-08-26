import { createClient } from '@supabase/supabase-js'

type Supabase = ReturnType<typeof createClient>
type PlayerRow = { id:string; source:string; source_player_id:string|null; name:string; current_team_id:string|null }
type MatchStat = {
  matchId:string
  minutes:number|null
  shots:number
  shotsOnTarget:number
  goals:number
  assists:number
  yellowCards:number
  redCards:number
  foulsCommitted:number|null
  foulsWon:number|null
  xg:number|null
  xa:number|null
}

function key(v:any){ return String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,'') }
function clean(v:any){ return String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ') }
function num(v:any){ const n=Number(typeof v==='object'&&v?(v.value??v.stat??v.total??NaN):v); return Number.isFinite(n)?n:null }
function text(v:any):string{
  if(v==null) return ''
  if(typeof v==='string'||typeof v==='number') return String(v).trim()
  if(typeof v==='object') return String(v.fullName??v.text??v.name??v.label??v.type??v.color??[v.firstName,v.lastName].filter(Boolean).join(' ')??'').trim()
  return ''
}
function flatten(v:any):any[]{
  if(!Array.isArray(v)) return []
  const out:any[]=[]
  for(const item of v){ if(Array.isArray(item)) out.push(...flatten(item)); else if(item!=null) out.push(item) }
  return out
}
function sleep(ms:number){ return new Promise((resolve)=>setTimeout(resolve,ms)) }
function avg(values:Array<number|null|undefined>){
  const xs=values.filter((v):v is number=>typeof v==='number'&&Number.isFinite(v))
  return xs.length?Math.round(xs.reduce((a,b)=>a+b,0)/xs.length*100)/100:null
}

function findStat(node:any,aliases:string[]):number|null{
  if(node==null) return null
  const wanted=new Set(aliases.map(key))
  const visit=(value:any,depth=0):number|null=>{
    if(value==null||depth>5) return null
    if(Array.isArray(value)){ for(const item of value){ const got=visit(item,depth+1); if(got!=null) return got } return null }
    if(typeof value!=='object') return null
    for(const [k,v] of Object.entries(value)){
      if(wanted.has(key(k))){ const n=num(v); if(n!=null) return n }
      if(typeof v==='object'&&v){
        const title=(v as any).title??(v as any).name??(v as any).key
        if(title&&wanted.has(key(title))){ const n=num((v as any).value??(v as any).stat??(v as any).total); if(n!=null) return n }
      }
    }
    for(const v of Object.values(value)){ if(typeof v==='object'&&v){ const got=visit(v,depth+1); if(got!=null) return got } }
    return null
  }
  return visit(node)
}

async function fetchJson(urls:string[]){
  let last='FotMob request failed'
  for(const url of urls){
    try{
      const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.9 player-form-cards'}})
      if(!response.ok){ last=`${response.status} ${response.statusText}`; if(response.status===429) await sleep(1400); continue }
      const body=await response.json()
      if(body&&typeof body==='object') return body
      last='Unexpected FotMob payload'
    }catch(error){ last=error instanceof Error?error.message:String(error) }
  }
  throw new Error(last)
}

async function fetchPlayerMatches(playerId:string,before:number){
  return fetchJson([
    `https://www.fotmob.com/api/data/playerMatches?playerId=${encodeURIComponent(playerId)}&before=${before}`,
    `https://www.fotmob.com/api/playerMatches?playerId=${encodeURIComponent(playerId)}&before=${before}`,
  ])
}

async function fetchDetails(matchId:string){
  return fetchJson([
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ])
}

function matchRows(payload:any){
  const direct=[payload?.matches,payload?.data?.matches,payload?.matchHistory,payload?.fixtures,payload?.data?.fixtures,payload?.matches?.matches]
  for(const candidate of direct) if(Array.isArray(candidate)) return flatten(candidate)
  const queue:Array<{v:any;depth:number}>=[{v:payload,depth:0}]
  let best:any[]=[]
  while(queue.length){
    const {v,depth}=queue.shift()!
    if(!v||typeof v!=='object'||depth>3) continue
    if(Array.isArray(v)){
      const objects=v.filter((x)=>x&&typeof x==='object')
      const matchish=objects.filter((x:any)=>x.matchId!=null||x.id!=null).length
      if(matchish>=Math.max(1,Math.floor(objects.length*.5))&&objects.length>best.length) best=objects
      for(const child of objects) queue.push({v:child,depth:depth+1})
    }else{
      for(const child of Object.values(v)) if(child&&typeof child==='object') queue.push({v:child,depth:depth+1})
    }
  }
  return best
}

function rowMatchId(row:any){ return text(row?.matchId??row?.id??row?.match?.id??row?.fixtureId) }
function rowKickoff(row:any){
  const raw=row?.status?.utcTime??row?.utcTime??row?.matchTimeUTCDate??row?.date??row?.time
  if(raw){ const d=new Date(raw); if(!Number.isNaN(d.getTime())) return d }
  const ts=num(row?.timeTS??row?.timestamp)
  if(ts!=null){ const d=new Date(ts>1e12?ts:ts*1000); if(!Number.isNaN(d.getTime())) return d }
  return null
}

function lineupGroups(payload:any){
  const current=payload?.content?.lineup?.lineup
  if(Array.isArray(current)) return current.map((g:any)=>({teamId:text(g?.teamId??g?.team?.id),players:flatten(g?.players??g?.optaLineup?.players)}))
  const direct=payload?.content?.lineup?.lineups??payload?.content?.lineup2?.lineups
  if(Array.isArray(direct)) return direct.map((g:any)=>({teamId:text(g?.teamId??g?.team?.id),players:flatten(g?.players)}))
  const line=payload?.content?.lineup
  const out:any[]=[]
  for(const side of ['homeTeam','awayTeam'] as const){
    const team=line?.[side]
    if(!team) continue
    out.push({teamId:text(team?.id??team?.teamId),players:[...flatten(team?.starters),...flatten(team?.subs??team?.substitutes)]})
  }
  return out
}

function allEvents(payload:any){
  const a=Array.isArray(payload?.header?.events)?payload.header.events:[]
  const b=Array.isArray(payload?.content?.matchFacts?.events?.events)?payload.content.matchFacts.events.events:[]
  return [...a,...b]
}
function eventPlayerMatches(event:any,playerId:string,playerName:string){
  const ids=[
    event?.player?.id,event?.playerId,event?.player?.playerId,event?.person?.id,
    event?.card?.playerId,event?.card?.player?.id,event?.eventPlayer?.id,
  ].map(text).filter(Boolean)
  if(playerId&&ids.includes(playerId)) return true
  const wanted=clean(playerName)
  if(!wanted) return false
  const names=[event?.player?.name,event?.playerName,event?.person?.name,event?.card?.player?.name,event?.eventPlayer?.name].map(text).map(clean).filter(Boolean)
  return names.includes(wanted)
}
function eventDescriptor(event:any){
  return key([
    event?.type,event?.eventType,event?.card,event?.cardType,event?.cardColor,
    event?.card?.type,event?.card?.color,event?.card?.name,event?.card?.label,
    event?.reason,event?.description,
  ].map(text).filter(Boolean).join(' '))
}
function eventCount(events:any[],playerId:string,playerName:string,typeWords:string[]){
  const wanted=typeWords.map(key)
  return events.filter((event)=>{
    if(!eventPlayerMatches(event,playerId,playerName)) return false
    const descriptor=eventDescriptor(event)
    return wanted.some((word)=>descriptor.includes(word))
  }).length
}

function statFromDetail(payload:any,sourcePlayerId:string,playerName:string,matchId:string):MatchStat|null{
  let item:any=null
  for(const group of lineupGroups(payload)){
    for(const raw of flatten(group.players)){
      const p=raw?.player??raw
      const pid=text(p?.id??p?.playerId??raw?.id)
      const name=text(p?.name??p?.playerName??raw?.name)
      if((sourcePlayerId&&pid===sourcePlayerId)||clean(name)===clean(playerName)){ item=raw; break }
    }
    if(item) break
  }
  const p=item?.player??item
  const shotmap=Array.isArray(payload?.content?.shotmap?.shots)?payload.content.shotmap.shots:[]
  const playerShots=shotmap.filter((s:any)=>text(s?.playerId??s?.player?.id)===sourcePlayerId)
  const events=allEvents(payload)
  const rowEvidence=item!=null||playerShots.length>0||events.some((event:any)=>eventPlayerMatches(event,sourcePlayerId,playerName))
  if(!rowEvidence) return null
  const shots=playerShots.length||findStat(p,['shots','total shots','shot attempts'])||findStat(item,['shots','total shots'])||0
  const sotMap=playerShots.filter((s:any)=>Boolean(s?.isOnTarget)||['goal','attemptsaved','saved'].some((w)=>key(s?.eventType??s?.type).includes(w))).length
  const shotsOnTarget=sotMap||findStat(p,['shots on target','shotsontarget','ontarget'])||findStat(item,['shots on target','shotsontarget'])||0
  return {
    matchId,
    minutes:num(p?.minutesPlayed??item?.minutesPlayed)??findStat(p,['minutes played','minutes','mins'])??findStat(item,['minutes played','minutes']),
    shots,
    shotsOnTarget,
    goals:eventCount(events,sourcePlayerId,playerName,['goal'])||findStat(p,['goals','goal'])||0,
    assists:findStat(p,['assists','assist'])??findStat(item,['assists'])??0,
    yellowCards:eventCount(events,sourcePlayerId,playerName,['yellowcard','yellow'])||findStat(p,['yellow card','yellow cards','yellowcard','yellowcards','booking','bookings'])||findStat(item,['yellow card','yellow cards','yellowcard','yellowcards','booking','bookings'])||0,
    redCards:eventCount(events,sourcePlayerId,playerName,['redcard','red'])||findStat(p,['red card','red cards','redcard','redcards'])||findStat(item,['red card','red cards','redcard','redcards'])||0,
    foulsCommitted:findStat(p,['fouls committed','fouls'])??findStat(item,['fouls committed']),
    foulsWon:findStat(p,['fouls won','was fouled'])??findStat(item,['fouls won']),
    xg:findStat(p,['expected goals','xg'])??findStat(item,['expected goals','xg']),
    xa:findStat(p,['expected assists','xa'])??findStat(item,['expected assists','xa']),
  }
}

function statFromMatchRow(row:any,matchId:string):MatchStat|null{
  const minutes=findStat(row,['minutes played','minutes','mins'])
  const shots=findStat(row,['shots','total shots','shot attempts'])
  const sot=findStat(row,['shots on target','shotsontarget','ontarget'])
  const goals=findStat(row,['goals','goal'])
  const assists=findStat(row,['assists','assist'])
  const cards=findStat(row,['yellow card','yellow cards','yellowcard','yellowcards','booking','bookings'])
  const hasAppearanceEvidence=minutes!=null||shots!=null||sot!=null||goals!=null||assists!=null||cards!=null||num(row?.rating)!=null||num(row?.minutes)!=null
  if(!hasAppearanceEvidence) return null
  return {
    matchId,
    minutes,
    shots:shots??0,
    shotsOnTarget:sot??0,
    goals:goals??0,
    assists:assists??0,
    yellowCards:cards??0,
    redCards:findStat(row,['red card','red cards','redcard','redcards'])??0,
    foulsCommitted:findStat(row,['fouls committed','fouls']),
    foulsWon:findStat(row,['fouls won','was fouled']),
    xg:findStat(row,['expected goals','xg']),
    xa:findStat(row,['expected assists','xa']),
  }
}

export async function loadConfirmedStarterFormCache(supabase:Supabase,fixtureId:string,targetMatches=10){
  const {data:fixture,error:fixtureError}=await supabase.from('fixtures').select('id,kickoff,home_team_id,away_team_id').eq('id',fixtureId).maybeSingle()
  if(fixtureError||!fixture) throw new Error(fixtureError?.message??'Fixture not found')

  const probe=await supabase.from('fixture_player_form_cache').select('fixture_id').eq('fixture_id',fixtureId).limit(1)
  if(probe.error){
    const message=probe.error.message??''
    if(/fixture_player_form_cache|does not exist|schema cache/i.test(message)) return {setupRequired:true,fixtureId,players:0,cachedPlayers:0,playersWith5:0,playersWith8:0,averageSample:0,warnings:['Run PATCH_PLAYER_FORM_CACHE_V1.sql']}
    throw probe.error
  }

  const {data:lineups,error:lineupError}=await supabase.from('fixture_lineups').select('team_id,player_id').eq('fixture_id',fixtureId).eq('is_starting',true)
  if(lineupError) throw lineupError
  const playerIds=[...new Set((lineups??[]).map((r:any)=>r.player_id))]
  if(!playerIds.length) return {setupRequired:false,fixtureId,players:0,cachedPlayers:0,playersWith5:0,playersWith8:0,averageSample:0,warnings:['No confirmed starters']}

  const {data:playerRows,error:playerError}=await supabase.from('players').select('id,source,source_player_id,name,current_team_id').in('id',playerIds)
  if(playerError) throw playerError
  const players=(playerRows??[]) as PlayerRow[]
  const teamByPlayer=new Map((lineups??[]).map((r:any)=>[r.player_id,r.team_id]))
  const before=Math.floor(Date.parse(fixture.kickoff)/1000)-1
  const detailCache=new Map<string,Promise<any>>()
  const warnings:string[]=[]
  const summaries:any[]=[]

  const getDetail=(matchId:string)=>{
    let pending=detailCache.get(matchId)
    if(!pending){ pending=fetchDetails(matchId); detailCache.set(matchId,pending) }
    return pending
  }

  for(const player of players){
    const sourcePlayerId=text(player.source_player_id)
    const numericId=/^\d+$/.test(sourcePlayerId)
    if(player.source!=='fotmob'||!numericId){
      summaries.push({playerId:player.id,name:player.name,sample:0,status:'no_fotmob_player_id'})
      continue
    }
    try{
      const history=await fetchPlayerMatches(sourcePlayerId,before)
      await sleep(80)
      const candidates=matchRows(history)
        .map((row:any)=>({row,matchId:rowMatchId(row),kickoff:rowKickoff(row)}))
        .filter((x:any)=>x.matchId&&(!x.kickoff||x.kickoff.getTime()<Date.parse(fixture.kickoff)))
      const seen=new Set<string>()
      const stats:MatchStat[]=[]
      for(const candidate of candidates.slice(0,Math.max(targetMatches+6,16))){
        if(stats.length>=targetMatches) break
        if(seen.has(candidate.matchId)) continue
        seen.add(candidate.matchId)
        let stat:MatchStat|null=null
        try{
          const detail=await getDetail(candidate.matchId)
          stat=statFromDetail(detail,sourcePlayerId,player.name,candidate.matchId)
        }catch(error){ warnings.push(`${player.name}/${candidate.matchId}: ${error instanceof Error?error.message:String(error)}`) }
        if(!stat) stat=statFromMatchRow(candidate.row,candidate.matchId)
        if(stat) stats.push(stat)
        await sleep(55)
      }

      const teamId=teamByPlayer.get(player.id)??player.current_team_id
      if(!teamId) continue
      const cacheRow={
        fixture_id:fixtureId,
        player_id:player.id,
        team_id:teamId,
        matches_sample:stats.length,
        avg_minutes:avg(stats.map((s)=>s.minutes)),
        avg_shots:avg(stats.map((s)=>s.shots)),
        avg_shots_on_target:avg(stats.map((s)=>s.shotsOnTarget)),
        avg_goals:avg(stats.map((s)=>s.goals)),
        avg_assists:avg(stats.map((s)=>s.assists)),
        avg_yellow_cards:avg(stats.map((s)=>s.yellowCards)),
        avg_red_cards:avg(stats.map((s)=>s.redCards)),
        avg_fouls_committed:avg(stats.map((s)=>s.foulsCommitted)),
        avg_fouls_won:avg(stats.map((s)=>s.foulsWon)),
        avg_xg:avg(stats.map((s)=>s.xg)),
        avg_xa:avg(stats.map((s)=>s.xa)),
        source:'fotmob-player-matches',
        source_match_ids:stats.map((s)=>s.matchId),
        refreshed_at:new Date().toISOString(),
      }
      const {error}=await supabase.from('fixture_player_form_cache').upsert(cacheRow,{onConflict:'fixture_id,player_id'})
      if(error) throw error
      summaries.push({playerId:player.id,name:player.name,sample:stats.length,status:stats.length>=5?'usable':'thin',yellowCards:cacheRow.avg_yellow_cards})
    }catch(error){
      warnings.push(`${player.name}: ${error instanceof Error?error.message:String(error)}`)
      summaries.push({playerId:player.id,name:player.name,sample:0,status:'error'})
    }
  }

  const samples=summaries.map((s)=>Number(s.sample??0))
  return {
    setupRequired:false,
    fixtureId,
    players:players.length,
    cachedPlayers:samples.filter((n)=>n>0).length,
    playersWith5:samples.filter((n)=>n>=5).length,
    playersWith8:samples.filter((n)=>n>=8).length,
    averageSample:samples.length?Math.round(samples.reduce((a,b)=>a+b,0)/samples.length*10)/10:0,
    detailRequests:detailCache.size,
    summaries,
    warnings:warnings.slice(0,30),
  }
}
