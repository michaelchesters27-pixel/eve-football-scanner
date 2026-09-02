import syncFotMobFixtures from './sync-fotmob-fixtures'

// Refresh fixture list/kickoffs just before the hourly match-intelligence pass.
// This uses FotMob only and does not consume The Odds API quota.
export const config={schedule:'55 * * * *'}

export default async()=>{
  const response=await syncFotMobFixtures()
  const body=await response.text()
  return new Response(body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}})
}
