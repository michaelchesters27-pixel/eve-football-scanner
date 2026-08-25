import syncPlayerStats from './sync-fotmob-player-stats'

export default async()=>{
  const response=await syncPlayerStats()
  if(!response.ok) throw new Error(`Player sync failed: ${await response.text()}`)
}
