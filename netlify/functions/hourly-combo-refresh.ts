import runCombos from './run-combos'

export const config={schedule:'50 * * * *'}

export default async()=>{
  const response=await runCombos()
  const body=await response.text()
  return new Response(body,{status:response.status,headers:{'content-type':'application/json','cache-control':'no-store'}})
}
