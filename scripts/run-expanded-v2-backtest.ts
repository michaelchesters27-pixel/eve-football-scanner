import runBacktest from '../netlify/functions/run-expanded-backtest-v2'

const response = await runBacktest()
const text = await response.text()
console.log(text)
if (!response.ok) process.exit(1)
const parsed = JSON.parse(text)
if (!parsed?.ok) process.exit(1)
