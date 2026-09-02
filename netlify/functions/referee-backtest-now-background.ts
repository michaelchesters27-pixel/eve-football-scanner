import backfillFootballData from './backfill-football-data'
import runRefereeBacktest from './run-referee-backtest'
import runRefereeMatchCardsBacktest from './run-referee-matchcards-backtest'

export default async()=>{
  const backfill=await backfillFootballData(new Request('https://eve.local/backfill-football-data?season=2425'))
  if(!backfill.ok) throw new Error(`2024/25 backfill failed: ${await backfill.text()}`)
  const core=await runRefereeBacktest()
  if(!core.ok) throw new Error(`Core referee backtest failed: ${await core.text()}`)
  const matchCards=await runRefereeMatchCardsBacktest()
  if(!matchCards.ok) throw new Error(`Match-card referee backtest failed: ${await matchCards.text()}`)
}
