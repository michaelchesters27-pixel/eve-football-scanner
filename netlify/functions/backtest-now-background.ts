import backfillFootballData from './backfill-football-data'
import runBacktest from './run-backtest'

// Background run: first ensure 2024/25 exists as pre-match history,
// then replay 2025/26 in strict chronological order.
export default async () => {
  const backfill = await backfillFootballData(new Request('https://eve.local/backfill-football-data?season=2425'))
  if (!backfill.ok) throw new Error(`2024/25 backfill failed: ${await backfill.text()}`)
  await runBacktest()
}
