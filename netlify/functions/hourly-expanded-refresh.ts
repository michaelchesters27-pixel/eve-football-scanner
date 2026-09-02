import runExpandedMarkets from './run-expanded-markets'

export const config={schedule:'30 * * * *'}

export default async()=>{
  const response=await runExpandedMarkets()
  const body=await response.text()
  return new Response(body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}})
}
