import { createClient } from '@supabase/supabase-js'

// Second-source referee discovery. FotMob remains the primary match-detail feed at
// :00. At :05 this checks Sofascore only for fixtures that still have no confirmed
// referee, then the normal :10 reconciliation job links the name to EVE history.
export const config={schedule:'5 * * * *'}

const SOURCE='sofascore-referee-fallback'
const MAX_FIXTURES=120
const LOOKAHEAD_MS=4*24*3600000

function env(name:string){const value=process.env[name];if(!value)throw new Error(`Missing required environment variable: ${name}`);return value}
function clean(value:string){return String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(fc|afc|cf|sc|club)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ')}
function similarity(a:string,b:string){
  const aa=clean(a),bb=clean(b)
  if(!aa||!bb)return 0
  if(aa===bb)return 1
  if(aa.includes(bb)||bb.includes(aa))return .92
  const as=new Set(aa.split(' ')),bs=new Set(bb.split(' '))
  const common=[...as].filter((x)=>bs.has(x)).length
  const union=new Set([...as,...bs]).size
  return union?common/union:0
}
function londonDate(value:string){
  const d=new Date(value)
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d)
  const get=(type:string)=>parts.find((p)=>p.type===type)?.value??''
  return `${get('year')}-${get('month')}-${get('day')}`
}
function eventKickoff(event:any){
  const ts=Number(event?.startTimestamp??event?.startTimeTimestamp??NaN)
  return Number.isFinite(ts)?ts*1000:NaN
}
function refereeName(value:any){
  const raw=value?.referee?.name??value?.event?.referee?.name??value?.referee?.fullName??value?.event?.referee?.fullName
  return typeof raw==='string'?raw.trim():''
}
async function json(url:string){
  const response=await fetch(url,{headers:{accept:'application/json,text/plain,*/*','user-agent':'Mozilla/5.0 EVE-Football-Scanner/1.0 referee-fallback'}})
  if(!response.ok)throw new Error(`${response.status} ${response.statusText}`)
  return response.json()
}

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const now=new Date(),horizon=new Date(now.getTime()+LOOKAHEAD_MS)
  const {data:run}=await supabase.from('source_sync_runs').insert({source:SOURCE,job_name:'hourly-referee-fallback',status:'running'}).select('id').single()
  try{
    const {data:fixtures,error}=await supabase.from('fixtures')
      .select('id,kickoff,home:teams!fixtures_home_team_id_fkey(name),away:teams!fixtures_away_team_id_fkey(name)')
      .in('status',['scheduled','live'])
      .gte('kickoff',new Date(now.getTime()-3*3600000).toISOString())
      .lte('kickoff',horizon.toISOString())
      .order('kickoff',{ascending:true})
      .limit(MAX_FIXTURES)
    if(error)throw error
    const ids=(fixtures??[]).map((f:any)=>f.id)
    const {data:contexts,error:contextError}=ids.length?await supabase.from('manual_match_context').select('fixture_id,referee_name,referee_confirmed,lineups_confirmed,notes').in('fixture_id',ids):{data:[] as any[],error:null}
    if(contextError)throw contextError
    const contextMap=new Map((contexts??[]).map((row:any)=>[row.fixture_id,row]))
    const pending=(fixtures??[]).filter((f:any)=>!contextMap.get(f.id)?.referee_confirmed)

    const dateCache=new Map<string,any[]>()
    const detailCache=new Map<string,any>()
    const results:any[]=[]
    let confirmed=0,apiCalls=0

    for(const fixture of pending){
      const date=londonDate(fixture.kickoff)
      let events=dateCache.get(date)
      if(!events){
        try{
          const payload=await json(`https://www.sofascore.com/api/v1/sport/football/scheduled-events/${date}`)
          apiCalls+=1
          events=Array.isArray(payload?.events)?payload.events:[]
        }catch(error){
          results.push({fixtureId:fixture.id,status:'date_feed_error',error:error instanceof Error?error.message:String(error)})
          dateCache.set(date,[])
          continue
        }
        dateCache.set(date,events)
      }

      const kickoff=Date.parse(fixture.kickoff)
      let best:any=null,bestScore=0
      for(const event of events){
        const eventTime=eventKickoff(event)
        if(!Number.isFinite(eventTime)||Math.abs(eventTime-kickoff)>8*3600000)continue
        const hs=similarity(String(fixture.home?.name??''),String(event?.homeTeam?.name??''))
        const as=similarity(String(fixture.away?.name??''),String(event?.awayTeam?.name??''))
        if(hs<.58||as<.58)continue
        const timeScore=Math.max(0,1-Math.abs(eventTime-kickoff)/(8*3600000))
        const score=hs*.46+as*.46+timeScore*.08
        if(score>bestScore){best=event;bestScore=score}
      }
      if(!best||bestScore<.66){results.push({fixtureId:fixture.id,status:'no_safe_event_match'});continue}

      let name=refereeName(best)
      const eventId=String(best?.id??'')
      if(!name&&eventId){
        try{
          let detail=detailCache.get(eventId)
          if(!detail){detail=await json(`https://www.sofascore.com/api/v1/event/${encodeURIComponent(eventId)}`);detailCache.set(eventId,detail);apiCalls+=1}
          name=refereeName(detail)
        }catch(error){results.push({fixtureId:fixture.id,eventId,status:'event_detail_error',error:error instanceof Error?error.message:String(error)});continue}
      }
      if(!name){results.push({fixtureId:fixture.id,eventId,status:'referee_not_in_source'});continue}

      const previous=contextMap.get(fixture.id)
      const stamp=new Date().toISOString()
      let writeError:any=null
      if(previous){
        const result=await supabase.from('manual_match_context').update({referee_name:name,referee_confirmed:true,confirmed_at:stamp,updated_at:stamp,notes:previous.notes??'Automatic referee discovery'}).eq('fixture_id',fixture.id)
        writeError=result.error
      }else{
        const result=await supabase.from('manual_match_context').insert({fixture_id:fixture.id,referee_name:name,referee_confirmed:true,lineups_confirmed:false,confirmed_at:stamp,updated_at:stamp,notes:'Automatic referee discovery'})
        writeError=result.error
      }
      if(writeError){results.push({fixtureId:fixture.id,eventId,status:'write_error',error:writeError.message});continue}
      confirmed+=1
      results.push({fixtureId:fixture.id,eventId,status:'referee_confirmed',referee:name,matchScore:Math.round(bestScore*100)/100})
    }

    const summary={checked:pending.length,confirmed,apiCalls,results:results.slice(0,120)}
    if(run?.id)await supabase.from('source_sync_runs').update({status:'success',rows_upserted:confirmed,finished_at:new Date().toISOString(),error_message:JSON.stringify(summary).slice(0,5000)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:true,...summary,note:'Second-source safety net only. FotMob remains primary; this fills a referee name only when EVE still has no confirmed referee. The :10 referee reconciliation job then verifies/links historical referee intelligence.'}),{headers:{'content-type':'application/json','cache-control':'no-store'}})
  }catch(error){
    if(run?.id)await supabase.from('source_sync_runs').update({status:'failed',finished_at:new Date().toISOString(),error_message:error instanceof Error?error.message:String(error)}).eq('id',run.id)
    return new Response(JSON.stringify({ok:false,error:error instanceof Error?error.message:String(error)}),{status:500,headers:{'content-type':'application/json','cache-control':'no-store'}})
  }
}
