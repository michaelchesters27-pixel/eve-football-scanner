import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ResultsPage from './ResultsPage'
import RefWatchPage from './RefWatchPage'
import './styles.css'
import './expansion.css'
import './results.css'
import './ref-watch.css'

function installMatchSetupAdminGuard(){
  const browser=window as typeof window & { __eveAdminFetchGuardInstalled?: boolean }
  if(browser.__eveAdminFetchGuardInstalled)return
  browser.__eveAdminFetchGuardInstalled=true
  const nativeFetch=window.fetch.bind(window)

  window.fetch=async(input:RequestInfo|URL,init?:RequestInit)=>{
    const target=input instanceof Request?input.url:String(input)
    const method=String(init?.method ?? (input instanceof Request?input.method:'GET')).toUpperCase()
    const protectedWrite=method==='POST' && target.includes('/.netlify/functions/confirm-match-context')
    if(!protectedWrite)return nativeFetch(input,init)

    const entered=window.prompt('Enter the EVE Match Setup admin key to save this manual override')
    const adminKey=entered?.trim() ?? ''
    if(!adminKey){
      return new Response(JSON.stringify({ok:false,error:'Admin key required — manual override was not saved'}),{
        status:401,
        headers:{'content-type':'application/json','cache-control':'no-store'},
      })
    }

    const headers=new Headers(input instanceof Request?input.headers:undefined)
    if(init?.headers)new Headers(init.headers).forEach((value,key)=>headers.set(key,value))
    headers.set('x-eve-admin-key',adminKey)

    if(input instanceof Request){
      return nativeFetch(new Request(input,{...init,headers}))
    }
    return nativeFetch(input,{...init,headers})
  }
}

installMatchSetupAdminGuard()

function ResultsShortcut(){
  return <a className="results-shortcut" href="#/results" aria-label="Open EVE results and win rate">
    <span className="results-shortcut-icon">🏆</span>
    <span><strong>RESULTS</strong><small>WIN RATE</small></span>
  </a>
}

function RefWatchNavInjector(){
  useEffect(()=>{
    const nav=document.querySelector('.page-nav')
    if(!nav||nav.querySelector('[data-ref-watch="true"]'))return
    const button=document.createElement('button')
    button.dataset.refWatch='true'
    button.type='button'
    button.innerHTML='<span aria-hidden="true">🔥</span>Ref Watch'
    button.addEventListener('click',()=>{window.location.hash='/refwatch'})
    const combo=Array.from(nav.children).find((node)=>node.textContent?.includes('Combo Lab'))??null
    nav.insertBefore(button,combo)
    return()=>button.remove()
  },[])
  return null
}

function Root(){
  const route=()=>window.location.hash.replace(/^#\/?/,'')
  const [page,setPage]=useState(route)

  useEffect(()=>{
    const onHash=()=>setPage(route())
    window.addEventListener('hashchange',onHash)
    return()=>window.removeEventListener('hashchange',onHash)
  },[])

  if(page==='results')return <ResultsPage/>
  if(page==='refwatch')return <><RefWatchPage/><ResultsShortcut/></>
  return <>
    <App/>
    <RefWatchNavInjector/>
    <ResultsShortcut/>
  </>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
