import { createClient } from '@supabase/supabase-js'

type Supabase = ReturnType<typeof createClient>

function clean(v:string){ return v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ') }
function slug(v:string){ return clean(v).replace(/ /g,'-') }
function num(v:any){ const n=Number(typeof v==='object'&&v?(v.value??v.stat??v.total??NaN):v); return Number.isFinite(n)?n:null }
function key(v:any){ return String(v??'').toLowerCase().replace(/[^a-z0-9]+/g,'') }
function sleep(ms:number){ return new Promise((r)=>setTimeout(r,ms)) }
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

function findStat(node:any,aliases:string[]):number|null{
  if(node==null) return null
  const wanted=new Set(aliases.map(key))
  const visit=(value:any):number|null=>{
    if(value==null) return null
    if(Array.isArray(value)){ for(const item of value){ const got=visit(item); if(got!=null) return got } return null }
    if(typeof value!=='object') return null
    for(const [k,v] of Object.entries(value)){
      if(wanted.has(key(k))){ const n=num(v); if(n!=null) return n }
      if(typeof v==='object'&&v){ const title=(v as any).title??(v as any).name??(v as any).key; if(title&&wanted.has(key(title))){ const n=num((v as any).value??(v as any).stat??(v as any).total); if(n!=null) return n } }
    }
    for(const v of Object.values(value)){ if(typeof v==='object'&&v){ const got=visit(v); if(got!=null) return got } }
    return null
  }
  return visit(node)
}

async function fetchJson(urls:string[]){
  let last='FotMob request failed'
  for(const url of urls){
    try{
      const r=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/0.9 player-history-cards'}})
      if(!r.ok){ last=`${r.status} ${r.statusText}`; if(r.status===429) await sleep(1500); continue }
      const body=await r.json(); if(body&&typeof body==='object') return body
      last='Unexpected FotMob payload'
    }catch(e){ last=e instanceof Error?e.message:String(e) }
  }
  throw new Error(last)
}

async function fetchTeam(teamId:string){
  return fetchJson([
    `https://www.fotmob.com/api/data/teams?id=${encodeURIComponent(teamId)}&ccode3=GBR`,
    `https://www.fotmob.com/api/teams?id=${encodeURIComponent(teamId)}`,
  ])
}

async function fetchDetails(matchId:string){
  return fetchJson([
    `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
    `https://www.fotmob.com/api/matchDetails?matchId=${encodeURIComponent(matchId)}`,
  ])
}

function fixtureList(payload:any){
  const candidates=[
    payload?.fixtures?.allFixtures?.fixtures,
    payload?.overview?.fixtures?.allFixtures?.fixtures,
    payload?.data?.fixtures?.allFixtures?.fixtures,
    payload?.fixtures,
  ]
  for(const x of candidates) if(Array.isArray(x)) return x
  return []
}

function detailKickoff(payload:any){
  const raw=payload?.header?.status?.utcTime
    ?? payload?.content?.matchFacts?.infoBox?.['Match Date']?.utcTime
    ?? payload?.content?.matchFacts?.infoBox?.matchDate?.utcTime
    ?? payload?.general?.matchTimeUTCDate
  const d=raw?new Date(raw):null
  return d&&!Number.isNaN(d.getTime())?d:null
}

function detailTeams(payload:any){
  const header=Array.isArray(payload?.header?.teams)?payload.header.teams:[]
  if(header.length>=2) return header.slice(0,2).map((t:any)=>({id:text(t?.id),name:text(t?.name)}))
  const home=payload?.content?.lineup?.homeTeam
  const away=payload?.content?.lineup?.awayTeam
  if(home&&away) return [{id:text(home?.id??home?.teamId),name:text(home?.name)},{id:text(away?.id??away?.teamId),name:text(away?.name)}]
  const groups=payload?.content?.lineup?.lineup
  if(Array.isArray(groups)&&groups.length>=2) return groups.slice(0,2).map((g:any)=>({id:text(g?.teamId??g?.team?.id),name:text(g?.team?.name)}))
  return []
}

function allEvents(payload:any){
  const a=Array.isArray(payload?.header?.events)?payload.header.events:[]
  const b=Array.isArray(payload?.content?.matchFacts?.events?.events)?payload.content.matchFacts.events.events:[]
  return [...a,...b]
}
function eventPlayerMatches(event:any,playerId:string,playerName:string){
  const ids=[event?.player?.id,event?.playerId,event?.player?.playerId,event?.person?.id,event?.card?.playerId,event?.card?.player?.id,event?.eventPlayer?.id].map(text).filter(Boolean)
  if(playerId&&ids.includes(playerId)) return true
  const wanted=clean(playerName)
  if(!wanted) return false
  const names=[event?.player?.name,event?.playerName,event?.person?.name,event?.card?.player?.name,event?.eventPlayer?.name].map(text).map(clean).filter(Boolean)
  return names.includes(wanted)
}
function eventDescriptor(event:any){
  return key([event?.type,event?.eventType,event?.card,event?.cardType,event?.cardColor,event?.card?.type,event?.card?.color,event?.card?.name,event?.card?.label,event?.reason,event?.description].map(text).filter(Boolean).join(' '))
}
function eventCount(events:any[],playerId:string,playerName:string,typeWords:string[]){
  const wanted=typeWords.map(key)
  return events.filter((event)=>eventPlayerMatches(event,playerId,playerName)&&wanted.some((word)=>eventDescriptor(event).includes(word))).length
}

function lineupGroups(payload:any){
  const current=payload?.content?.lineup?.lineup
  if(Array.isArray(current)){
    return current.map((g:any)=>({teamId:text(g?.teamId??g?.team?.id),players:flatten(g?.players??g?.optaLineup?.players).map((p:any)=>({...p,isStarter:true}))}))
  }
  const direct=payload?.content?.lineup?.lineups ?? payload?.content?.lineup2?.lineups
  if(Array.isArray(direct)) return direct.map((g:any)=>({teamId:text(g?.teamId??g?.team?.id),players:flatten(g?.players)}))
  const line=payload?.content?.lineup
  const out:any[]=[]
  for(const side of ['homeTeam','awayTeam'] as const){
    const team=line?.[side]
    if(!team) continue
    const starters=flatten(team?.starters).map((p:any)=>({...p,isStarter:true}))
    const subs=flatten(team?.subs??team?.substitutes).map((p:any)=>({...p,isStarter:false}))
    out.push({teamId:text(team?.id??team?.teamId),players:[...starters,...subs]})
  }
  return out
}

async function mapDbFixture(supabase:Supabase,teamId:string,kickoff:Date){
  const from=new Date(kickoff.getTime()-8*3600000).toISOString()
  const to=new Date(kickoff.getTime()+8*3600000).toISOString()
  const {data,error}=await supabase.from('fixtures')
    .select('id,home_team_id,away_team_id,kickoff,match_context')
    .eq('status','finished')
    .gte('kickoff',from).lte('kickoff',to)
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
  if(error||!data?.length) return null
  return [...data].sort((a:any,b:any)=>Math.abs(Date.parse(a.kickoff)-kickoff.getTime())-Math.abs(Date.parse(b.kickoff)-kickoff.getTime()))[0] as any
}

async function upsertDetail(supabase:Supabase,dbFixture:any,payload:any,currentInternalTeamId:string,currentFotmobTeamId:string){
  const teams=detailTeams(payload)
  if(teams.length<2) return {players:0,stats:0,lineups:0,reason:'No team identities in match detail'}
  const homeFotmob=text(teams[0].id),awayFotmob=text(teams[1].id)
  const currentIsHome=homeFotmob===currentFotmobTeamId
  const currentIsAway=awayFotmob===currentFotmobTeamId
  if(!currentIsHome&&!currentIsAway) return {players:0,stats:0,lineups:0,reason:'Current FotMob team not present in detail'}
  const teamMap=new Map<string,string>()
  if(currentIsHome){ teamMap.set(homeFotmob,currentInternalTeamId); teamMap.set(awayFotmob,dbFixture.away_team_id) }
  else { teamMap.set(awayFotmob,currentInternalTeamId); teamMap.set(homeFotmob,dbFixture.home_team_id) }

  const shotmap=Array.isArray(payload?.content?.shotmap?.shots)?payload.content.shotmap.shots:[]
  const events=allEvents(payload)
  let players=0,stats=0,lineups=0
  for(const group of lineupGroups(payload)){
    const internalTeamId=teamMap.get(text(group.teamId))
    if(!internalTeamId) continue
    const groupPlayers=flatten(group.players)
    for(let idx=0;idx<groupPlayers.length;idx+=1){
      const item=groupPlayers[idx]
      const p=item?.player??item
      const rawId=text(p?.id??p?.playerId??item?.id)
      const name=text(p?.name??p?.playerName??item?.name)
      if(!name||name==='[object Object]') continue
      const sourcePlayerId=rawId||`name:${internalTeamId}:${slug(name)}`
      const localized=p?.localizedPosition??item?.localizedPosition
      const position=text(p?.positionStringShort??p?.positionString??p?.position??localized?.label??localized?.text??item?.position)||null
      const {data:player,error:playerError}=await supabase.from('players').upsert({source:'fotmob',source_player_id:sourcePlayerId,name,current_team_id:internalTeamId,position,updated_at:new Date().toISOString()},{onConflict:'source,source_player_id'}).select('id').single()
      if(playerError||!player?.id) continue
      players+=1
      const explicitStarter=p?.isStarter??item?.isStarter??item?.starter
      const started=typeof explicitStarter==='boolean'?explicitStarter:idx<11
      if(started){
        const {error}=await supabase.from('fixture_lineups').upsert({fixture_id:dbFixture.id,team_id:internalTeamId,player_id:player.id,is_starting:true,shirt_number:num(p?.shirtNumber??p?.shirt??item?.shirtNumber??item?.shirt),position,source:'fotmob',confirmed_at:new Date().toISOString()},{onConflict:'fixture_id,player_id,source'})
        if(!error) lineups+=1
      }
      const playerShots=shotmap.filter((s:any)=>text(s?.playerId??s?.player?.id)===rawId)
      const shots=playerShots.length||findStat(p,['shots','total shots','shot attempts'])||findStat(item,['shots','total shots'])||0
      const sotMap=playerShots.filter((s:any)=>Boolean(s?.isOnTarget)||['goal','attemptsaved','saved'].some((w)=>key(s?.eventType??s?.type).includes(w))).length
      const sot=sotMap||findStat(p,['shots on target','shotsontarget','ontarget'])||findStat(item,['shots on target','shotsontarget'])||0
      const goals=eventCount(events,rawId,name,['goal'])||findStat(p,['goals','goal'])||0
      const assists=findStat(p,['assists','assist'])||findStat(item,['assists'])||0
      const yellows=eventCount(events,rawId,name,['yellowcard','yellow'])||findStat(p,['yellow card','yellow cards','yellowcard','yellowcards','booking','bookings'])||findStat(item,['yellow card','yellow cards','yellowcard','yellowcards','booking','bookings'])||0
      const reds=eventCount(events,rawId,name,['redcard','red'])||findStat(p,['red card','red cards','redcard','redcards'])||findStat(item,['red card','red cards','redcard','redcards'])||0
      const minutes=num(p?.minutesPlayed??item?.minutesPlayed)??findStat(p,['minutes played','minutes','mins'])??findStat(item,['minutes played','minutes'])
      const foulsCommitted=findStat(p,['fouls committed','fouls'])??findStat(item,['fouls committed'])
      const foulsWon=findStat(p,['fouls won','was fouled'])??findStat(item,['fouls won'])
      const xg=findStat(p,['expected goals','xg'])??findStat(item,['expected goals','xg'])
      const xa=findStat(p,['expected assists','xa'])??findStat(item,['expected assists','xa'])
      const {error:statError}=await supabase.from('player_match_stats').upsert({fixture_id:dbFixture.id,player_id:player.id,team_id:internalTeamId,started,minutes,shots,shots_on_target:sot,goals,assists,yellow_cards:yellows,red_cards:reds,fouls_committed:foulsCommitted,fouls_won:foulsWon,xg,xa,source:'fotmob'},{onConflict:'fixture_id,player_id'})
      if(!statError) stats+=1
    }
  }
  return {players,stats,lineups}
}

export async function loadFixturePlayerHistory(supabase:Supabase,fixtureId:string,matchesPerTeam=10){
  const {data:fixture,error}=await supabase.from('fixtures').select('id,kickoff,home_team_id,away_team_id,match_context').eq('id',fixtureId).maybeSingle()
  if(error||!fixture) throw new Error(error?.message??'Fixture not found')
  const specs=[
    {internalId:fixture.home_team_id,fotmobId:text(fixture.match_context?.fotmob_home_team_id)},
    {internalId:fixture.away_team_id,fotmobId:text(fixture.match_context?.fotmob_away_team_id)},
  ].filter((x)=>x.fotmobId)
  const processed=new Set<string>()
  let mappedMatches=0,players=0,stats=0,lineups=0
  const warnings:string[]=[]

  for(const spec of specs){
    try{
      const team=await fetchTeam(spec.fotmobId)
      const raw=fixtureList(team).filter((f:any)=>f?.id)
      const finished=raw.filter((f:any)=>f?.status?.finished===true||f?.notStarted===false||f?.result!=null)
      const ordered=[...finished].sort((a:any,b:any)=>Date.parse(b?.status?.utcTime??b?.utcTime??'1970-01-01')-Date.parse(a?.status?.utcTime??a?.utcTime??'1970-01-01'))
      let accepted=0
      for(const old of ordered.slice(0,Math.max(matchesPerTeam*2,14))){
        if(accepted>=matchesPerTeam) break
        const matchId=String(old.id)
        if(processed.has(matchId)) continue
        processed.add(matchId)
        try{
          const detail=await fetchDetails(matchId)
          const kickoff=detailKickoff(detail)
          if(!kickoff||kickoff.getTime()>=Date.parse(fixture.kickoff)) continue
          const dbFixture=await mapDbFixture(supabase,spec.internalId,kickoff)
          if(!dbFixture) continue
          const result=await upsertDetail(supabase,dbFixture,detail,spec.internalId,spec.fotmobId)
          if(result.stats>0){ accepted+=1; mappedMatches+=1; players+=result.players; stats+=result.stats; lineups+=result.lineups }
        }catch(e){ warnings.push(`${matchId}: ${e instanceof Error?e.message:String(e)}`) }
        await sleep(140)
      }
    }catch(e){ warnings.push(`team ${spec.fotmobId}: ${e instanceof Error?e.message:String(e)}`) }
  }
  return {fixtureId,mappedMatches,players,stats,lineups,warnings:warnings.slice(0,20)}
}
