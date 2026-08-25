import runExpandedMarkets from './run-expanded-markets'

// Manual full expanded-market rebuild.
// Netlify treats *-background functions as long-running jobs, avoiding the
// normal synchronous function timeout that can produce a browser 502 when
// many fixtures need to be analysed.
export default async () => {
  const response = await runExpandedMarkets(new Request('https://eve.local/run-expanded-markets'))
  if (!response.ok) throw new Error(`Expanded market run failed: ${await response.text()}`)
}
