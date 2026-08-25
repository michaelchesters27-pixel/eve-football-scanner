import bootstrapPlayerHistory from './bootstrap-player-history'
import syncPlayerStats from './sync-fotmob-player-stats'

export default async()=>{
  const bootstrap=await bootstrapPlayerHistory()
  if(!bootstrap.ok) throw new Error(`Player bootstrap failed: ${await bootstrap.text()}`)
  const recent=await syncPlayerStats()
  if(!recent.ok) throw new Error(`Recent player sync failed: ${await recent.text()}`)
}
