import syncResults from './sync-fotmob-results'

export const config = { schedule: '7,22,37,52 * * * *' }

export default async()=>syncResults()
