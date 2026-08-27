import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ResultsPage from './ResultsPage'
import './styles.css'
import './expansion.css'
import './results.css'

function Root(){
  const isResults=()=>window.location.hash.replace(/^#\/?/,'')==='results'
  const [results,setResults]=useState(isResults)

  useEffect(()=>{
    const onHash=()=>setResults(isResults())
    window.addEventListener('hashchange',onHash)
    return()=>window.removeEventListener('hashchange',onHash)
  },[])

  if(results)return <ResultsPage/>
  return <><App/><a className="results-shortcut" href="#/results">Results</a></>
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
)
