const RESULT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const RESULT_OVERDUE_MS = 4 * 60 * 60 * 1000

function chunks<T>(items:T[],size=80){ const out:T[][]=[]; for(let i=0;i<items.length;i+=size) out.push(items.slice(i,i+size)); return out }

export async function auditResultIntegrity(supabase:any,nowMs=Date.now()){
  const since=new Date(nowMs-RESULT_LOOKBACK_MS).toISOString()
  const overdue=new Date(nowMs-RESULT_OVERDUE_MS).toISOString()
  const hardViolations:any[]=[]

  const [scannerResult,comboResult,recommendationResult]=await Promise.all([
    supabase.from('scanner_result_log')
      .select('id,fixtureId,sourcePage,outcome,kickoffUtc,fixtureStatus')
      .in('sourcePage',['best_bets','market_lab'])
      .eq('fixtureStatus','finished')
      .in('outcome',['pending','awaiting_data'])
      .gte('kickoffUtc',since)
      .lt('kickoffUtc',overdue)
      .limit(500),
    supabase.from('combo_result_log')
      .select('id,comboLogId,fixtureId,comboType,outcome,kickoffUtc,fixtureStatus')
      .eq('fixtureStatus','finished')
      .in('outcome',['pending','awaiting_data'])
      .gte('kickoffUtc',since)
      .lt('kickoffUtc',overdue)
      .limit(1000),
    supabase.from('combo_recommendations')
      .select('id,fixture_id,model_version,sample_size,calculated_at')
      .eq('model_version','v1-combo-research')
      .gte('calculated_at',since)
      .gte('sample_size',10)
      .limit(500),
  ])
  if(scannerResult.error) throw scannerResult.error
  if(comboResult.error) throw comboResult.error
  if(recommendationResult.error) throw recommendationResult.error

  const scannerRows=scannerResult.data??[]
  for(const row of scannerRows){
    hardViolations.push({
      type:row.outcome==='awaiting_data'?'finished_scanner_pick_awaiting_data':'finished_scanner_pick_still_pending',
      sourcePage:row.sourcePage,
      resultId:row.id,
      fixtureId:row.fixtureId,
      kickoff:row.kickoffUtc,
      outcome:row.outcome,
    })
  }

  const comboRows=comboResult.data??[]
  for(const row of comboRows){
    hardViolations.push({
      type:row.outcome==='awaiting_data'?'finished_combo_result_awaiting_data':'finished_combo_result_still_pending',
      resultId:row.id,
      comboLogId:row.comboLogId,
      fixtureId:row.fixtureId,
      comboType:row.comboType,
      kickoff:row.kickoffUtc,
      outcome:row.outcome,
    })
  }

  const recommendations=recommendationResult.data??[]
  const recommendationFixtureIds=[...new Set(recommendations.map((row:any)=>String(row.fixture_id??'')).filter(Boolean))] as string[]
  const trackedFixtureIds=new Set<string>()
  for(const batch of chunks(recommendationFixtureIds)){
    const {data,error}=await supabase.from('combo_result_log').select('fixtureId').in('fixtureId',batch)
    if(error) throw error
    for(const row of data??[]) if((row as any).fixtureId) trackedFixtureIds.add(String((row as any).fixtureId))
  }
  const missingTracking=recommendations.filter((row:any)=>!trackedFixtureIds.has(String(row.fixture_id)))
  for(const row of missingTracking){
    hardViolations.push({
      type:'combo_recommendation_missing_permanent_result_tracking',
      comboRecommendationId:row.id,
      fixtureId:row.fixture_id,
      modelVersion:row.model_version,
      sampleSize:row.sample_size,
      calculatedAt:row.calculated_at,
    })
  }

  return {
    hardViolations,
    summary:{
      resultLookbackDays:7,
      overdueAfterHours:4,
      overdueScannerResults:scannerRows.length,
      overdueBestBets:scannerRows.filter((row:any)=>row.sourcePage==='best_bets').length,
      overdueMarketLab:scannerRows.filter((row:any)=>row.sourcePage==='market_lab').length,
      overdueComboResults:comboRows.length,
      recentComboRecommendations:recommendations.length,
      recentComboRecommendationsMissingTracking:missingTracking.length,
    },
  }
}
