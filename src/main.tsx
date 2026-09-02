import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ResultsPage from './ResultsPage'
import RefWatchPage from './RefWatchPage'
import './styles.css'
import './expansion.css'
import './results.css'
import './ref-watch.css'

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
