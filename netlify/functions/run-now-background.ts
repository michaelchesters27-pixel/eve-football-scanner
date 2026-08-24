import runScanner from './run-scanner'

// Netlify treats files ending in -background as background functions.
// This avoids the normal synchronous function timeout while EVE scans
// the full upcoming fixture slate and writes predictions to Supabase.
export default async () => {
  await runScanner()
}
