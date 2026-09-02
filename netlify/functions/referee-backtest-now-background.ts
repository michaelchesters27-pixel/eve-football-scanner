import backfillFootballData from './backfill-football-data'
import runRefereeBacktest from './run-referee-backtest'

export default async()=>{
  const backfill=await backfillFootballData(new Request('https://eve.local/backfill-football-data?season=2425'))
  if(!backfill.ok) throw new Error(`2024/25 backfill failed: ${await backfill.text()}`)
  await runRefereeBacktest()
}
