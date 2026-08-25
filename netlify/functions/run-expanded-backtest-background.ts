import runExpandedBacktest from './run-expanded-backtest'
import applyExpandedCalibration from './apply-expanded-calibration'

// Manual long-running pipeline: replay 2025/26 using prior data only, then
// apply the resulting thresholds/fair probabilities to current 2026/27 signals.
export default async () => {
  const backtest = await runExpandedBacktest()
  if (!backtest.ok) throw new Error(`Expanded backtest failed: ${await backtest.text()}`)

  const calibration = await applyExpandedCalibration()
  if (!calibration.ok) throw new Error(`Expanded calibration failed: ${await calibration.text()}`)
}
