import runCoreScanner from './run-scanner'

export const config={schedule:'25 * * * *'}

export default async()=>{
  const response=await runCoreScanner()
  const body=await response.text()
  return new Response(body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}})
}
