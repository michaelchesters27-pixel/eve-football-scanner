import { createClient } from '@supabase/supabase-js'

function env(name:string){ const v=process.env[name]; if(!v) throw new Error(`Missing required environment variable: ${name}`); return v }
function mean(values:number[]){ return values.length?values.reduce((a,b)=>a+b,0)/values.length:0 }
function round1(n:number){ return Math.round(n*10)/10 }

export default async()=>{
  const supabase=createClient(env('SUPABASE_URL'),env('SUPABASE_SERVICE_ROLE_KEY'),{auth:{persistSession:false,autoRefreshToken:false}})
  const {data:fixtures,error}=await supabase.from('fixture_setup_board').select('*').eq('lineupsConfirmed',true).order('kickoff',{ascending:true}).limit(12)
  if(error) return new Response(JSON.stringify({ok:false,error:error.message}),{status:500,headers:{'content-type':'application/json'}})

  const matches:any[]=[]
  for(const fixture of fixtures??[]){
    const [{data:players},{data:snapshots}]=await Promise.all([
      supabase.from('fixture_player_outlook').select('teamId,teamName,name,matchesSample,avgMinutes,avgShots,avgShotsOnTarget,avgGoals,avgYellowCards').eq('fixtureId',fixture.fixtureId),
      supabase.from('feature_snapshots').select('market,selection_label,features,calculated_at').eq('fixture_id',fixture.fixtureId).eq('model_version','v1-expanded-research').order('calculated_at',{ascending:false}),
    ])
    const rows=players??[]
    const history=rows.filter((p:any)=>Number(p.matchesSample??0)>0)
    const reliable=rows.filter((p:any)=>Number(p.matchesSample??0)>=3&&Number(p.avgMinutes??0)>=30)
    const impacts=(snapshots??[]).map((s:any)=>({
      market:s.market,
      selection:s.selection_label,
      lineupImpact:s.features?.lineupImpact??null,
      lineupReliability:s.features?.lineup?.reliabilityPct??null,
      historyCoverage:s.features?.lineup?.historyCoveragePct??null,
    })).filter((x:any)=>x.lineupImpact||x.lineupReliability!=null)
    matches.push({
      fixtureId:fixture.fixtureId,
      match:`${fixture.homeTeam} v ${fixture.awayTeam}`,
      kickoff:fixture.kickoff,
      referee:fixture.referee??null,
      starters:{home:Number(fixture.homeStarters??0),away:Number(fixture.awayStarters??0)},
      playerHistory:{
        starters:rows.length,
        withHistory:history.length,
        reliable:reliable.length,
        coveragePct:rows.length?round1(reliable.length/rows.length*100):0,
        averageMatches:round1(mean(history.map((p:any)=>Number(p.matchesSample??0)))),
      },
      impacts:impacts.slice(0,8),
    })
  }

  const {data:runs}=await supabase.from('source_sync_runs').select('started_at,finished_at,status,rows_upserted,error_message').eq('job_name','lineup-history-enrichment').order('started_at',{ascending:false}).limit(3)
  return new Response(JSON.stringify({
    ok:true,
    confirmedMatches:matches.length,
    matches,
    latestEnrichmentRuns:runs??[],
    note:'A confirmed XI only influences EVE when player history is sufficiently covered. Thin samples remain close to neutral; the lineup layer is a small match-day refinement, not a separately proven betting edge.',
  }),{headers:{'content-type':'application/json'}})
}
