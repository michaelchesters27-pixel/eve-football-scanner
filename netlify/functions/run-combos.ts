import runCombosSafe from './run-combos-safe'

// Keep the legacy scheduled/function entry point for compatibility, but make it
// execute the same calibrated + freshness-gated implementation used by the
// hourly GitHub pipeline. There is now one Combo Lab rule set, not two.
export const config = { schedule: '50 5 * * *' }

export default async (request?: Request) => runCombosSafe(request)
