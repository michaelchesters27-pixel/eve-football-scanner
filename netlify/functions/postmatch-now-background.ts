import syncResults from './sync-fotmob-results'
import syncPlayerStats from './sync-fotmob-player-stats'

export default async()=>{
  const results=await syncResults()
  if(!results.ok) throw new Error(`Result sync failed: ${await results.text()}`)
  const players=await syncPlayerStats()
  if(!players.ok) throw new Error(`Player stat sync failed: ${await players.text()}`)
}
