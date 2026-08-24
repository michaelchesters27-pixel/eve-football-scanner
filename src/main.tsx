import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ValueDashboard from './ValueDashboard'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <ValueDashboard />
  </React.StrictMode>,
)
