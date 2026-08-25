import runCombos from './run-combos'

// Manual full combo rebuild. Background execution avoids browser timeouts when
// many upcoming fixtures need historical joint-frequency analysis.
export default async () => {
  const response = await runCombos(new Request('https://eve.local/run-combos'))
  if (!response.ok) throw new Error(`Combo run failed: ${await response.text()}`)
}
