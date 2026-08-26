import syncPlayerStats from './sync-fotmob-player-stats'

export const config = { schedule: '12,42 * * * *' }

export default async()=>syncPlayerStats()
