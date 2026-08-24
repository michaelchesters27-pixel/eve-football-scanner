import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import { CircleDollarSign } from 'lucide-react'

type ValueRow = {
  id: string
  country: string
  league: string
  homeTeam: string
  awayTeam: string
  kickoff: string
  market: string
  selection: string
  confidence: number
  fairProbability: number | null
  fairOdds: number | null
  bestBookmaker: string | null
  bestOdds: number | null
  impliedProbability: number | null
  edgePct: number | null
  expectedValuePct: number | null
  valueStatus: 'strong' | 'value' | 'no_value' | 'waiting' | 'uncalibrated'
}

function n(value: unknown) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export default function ValueDashboard() {
  const [rows, setRows] = useState<ValueRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined
    if (!url || !key) return

    const supabase = createClient(url, key)
    supabase.from('scanner_best_bets').select('*').limit(50).then(({ data, error }) => {
      if (error) { setError(error.message); return }
      setRows((data ?? []).map((r: any) => ({
        ...r,
        confidence: Number(r.confidence),
        fairProbability: n(r.fairProbability),
        fairOdds: n(r.fairOdds),
        bestOdds: n(r.bestOdds),
        impliedProbability: n(r.impliedProbability),
        edgePct: n(r.edgePct),
        expectedValuePct: n(r.expectedValuePct),
      })) as ValueRow[])
    })
  }, [])

  const priced = useMemo(() => rows.filter((r) => r.bestOdds != null), [rows])
  const value = useMemo(() => rows.filter((r) => r.valueStatus === 'value' || r.valueStatus === 'strong'), [rows])
  if (!rows.length && !error) return null

  const box: React.CSSProperties = { width: 'min(1180px,92vw)', margin: '0 auto 42px', padding: 20, border: '1px solid rgba(144,214,167,.14)', borderRadius: 20, background: 'linear-gradient(145deg,rgba(13,29,19,.96),rgba(7,15,10,.95))' }
  const card: React.CSSProperties = { padding: 14, borderRadius: 14, border: '1px solid rgba(255,255,255,.07)', background: 'rgba(255,255,255,.025)' }

  return <section style={box}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:14,marginBottom:14}}>
      <div style={{display:'flex',alignItems:'center',gap:10}}><CircleDollarSign size={22} color="#64d18d"/><div><div style={{fontSize:11,letterSpacing:'.16em',fontWeight:800,color:'#76c794'}}>VALUE ENGINE</div><strong style={{fontSize:22}}>Bookmaker value check</strong></div></div>
      <div style={{fontSize:12,fontWeight:800,color:value.length ? '#70e59b' : '#e9c76e'}}>{value.length ? `${value.length} VALUE BET${value.length === 1 ? '' : 'S'}` : 'NO VALUE RIGHT NOW'}</div>
    </div>
    {error && <div style={{color:'#ffad83',fontSize:12}}>Value data error: {error}</div>}
    {!error && <>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:8,marginBottom:12}}>
        <div style={card}><span style={{fontSize:10,color:'#7e9388'}}>LIVE SIGNALS</span><strong style={{display:'block',fontSize:22}}>{rows.length}</strong></div>
        <div style={card}><span style={{fontSize:10,color:'#7e9388'}}>PRICED</span><strong style={{display:'block',fontSize:22}}>{priced.length}</strong></div>
        <div style={card}><span style={{fontSize:10,color:'#7e9388'}}>VALUE</span><strong style={{display:'block',fontSize:22,color:value.length ? '#70e59b' : '#d9bd73'}}>{value.length}</strong></div>
      </div>
      {!value.length && <div style={{...card,marginBottom:10,color:'#cabb96',fontSize:12,lineHeight:1.5}}><strong style={{color:'#f0d693'}}>EVE is rejecting every priced selection.</strong> The current bookmaker prices are shorter than EVE's conservative fair price, so the correct action is no bet rather than forcing a selection.</div>}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:8}}>
        {rows.slice(0,12).map((r) => <div key={r.id} style={card}>
          <div style={{display:'flex',justifyContent:'space-between',gap:8,fontSize:10,color:'#71837a'}}><span>{r.league} · {r.kickoff}</span><strong style={{color:r.valueStatus === 'strong' || r.valueStatus === 'value' ? '#70e59b' : r.valueStatus === 'no_value' ? '#e2a093' : '#9eb4a8'}}>{r.valueStatus === 'strong' ? 'STRONG VALUE' : r.valueStatus === 'value' ? 'VALUE' : r.valueStatus === 'no_value' ? 'NO VALUE' : 'WAITING PRICE'}</strong></div>
          <strong style={{display:'block',margin:'6px 0 3px',fontSize:14}}>{r.homeTeam} v {r.awayTeam}</strong>
          <div style={{fontSize:11,color:'#a8b8af',marginBottom:8}}>{r.selection}</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:5,fontSize:10}}>
            <span>Fair odds <strong style={{float:'right'}}>{r.fairOdds?.toFixed(2) ?? '—'}</strong></span>
            <span>Best odds <strong style={{float:'right'}}>{r.bestOdds?.toFixed(2) ?? '—'}</strong></span>
            <span>Edge <strong style={{float:'right'}}>{r.edgePct == null ? '—' : `${r.edgePct > 0 ? '+' : ''}${r.edgePct.toFixed(1)}%`}</strong></span>
            <span>EV <strong style={{float:'right'}}>{r.expectedValuePct == null ? '—' : `${r.expectedValuePct > 0 ? '+' : ''}${r.expectedValuePct.toFixed(1)}%`}</strong></span>
          </div>
          {r.bestBookmaker && <div style={{fontSize:9,color:'#617168',marginTop:7}}>Best price: {r.bestBookmaker}</div>}
        </div>)}
      </div>
      <div style={{fontSize:9,color:'#506158',marginTop:10}}>VALUE requires at least +5 percentage-point probability edge and +5% expected value. STRONG VALUE requires +7pp and +10% EV. Fair probabilities are conservative walk-forward estimates, not guarantees.</div>
    </>}
  </section>
}
