import syncMatchdayContext from './sync-matchday-context'

export default async (request: Request) => {
  return syncMatchdayContext(request)
}
