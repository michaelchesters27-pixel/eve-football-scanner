export type LeagueConfig = {
  div: string
  countryCode: string
  country: string
  league: string
  slug: string
}

export const LEAGUES: LeagueConfig[] = [
  { div: 'E0', countryCode: 'ENG', country: 'England', league: 'Premier League', slug: 'premier-league' },
  { div: 'E1', countryCode: 'ENG', country: 'England', league: 'Championship', slug: 'championship' },
  { div: 'SC0', countryCode: 'SCO', country: 'Scotland', league: 'Premiership', slug: 'scottish-premiership' },
  { div: 'D1', countryCode: 'GER', country: 'Germany', league: 'Bundesliga', slug: 'bundesliga' },
  { div: 'I1', countryCode: 'ITA', country: 'Italy', league: 'Serie A', slug: 'serie-a' },
  { div: 'SP1', countryCode: 'ESP', country: 'Spain', league: 'La Liga', slug: 'la-liga' },
  { div: 'F1', countryCode: 'FRA', country: 'France', league: 'Ligue 1', slug: 'ligue-1' },
  { div: 'N1', countryCode: 'NED', country: 'Netherlands', league: 'Eredivisie', slug: 'eredivisie' },
  { div: 'B1', countryCode: 'BEL', country: 'Belgium', league: 'Pro League', slug: 'belgian-pro-league' },
  { div: 'P1', countryCode: 'POR', country: 'Portugal', league: 'Primeira Liga', slug: 'primeira-liga' },
  { div: 'T1', countryCode: 'TUR', country: 'Turkey', league: 'Super Lig', slug: 'super-lig' },
]

export const LEAGUE_BY_DIV = new Map(LEAGUES.map((league) => [league.div, league]))

export type FootballDataRow = Record<string, string>

export function parseCsv(input: string): FootballDataRow[] {
  const text = input.replace(/^\uFEFF/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"'
        i += 1
      } else if (char === '"') {
        quoted = false
      } else {
        cell += char
      }
      continue
    }

    if (char === '"') quoted = true
    else if (char === ',') {
      row.push(cell.trim())
      cell = ''
    } else if (char === '\n') {
      row.push(cell.trim().replace(/\r$/, ''))
      if (row.some(Boolean)) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }

  if (cell.length || row.length) {
    row.push(cell.trim().replace(/\r$/, ''))
    if (row.some(Boolean)) rows.push(row)
  }

  if (rows.length < 2) return []
  const headers = rows[0]
  return rows.slice(1).map((values) => {
    const out: FootballDataRow = {}
    headers.forEach((header, index) => { out[header] = values[index] ?? '' })
    return out
  })
}

export function currentSeasonCode(now = new Date()) {
  const year = now.getUTCFullYear()
  const start = now.getUTCMonth() >= 6 ? year : year - 1
  return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`
}

export function previousSeasonCodes(count = 3, now = new Date()) {
  const current = currentSeasonCode(now)
  const startFull = Number(`20${current.slice(0, 2)}`)
  return Array.from({ length: count }, (_, index) => {
    const start = startFull - index
    return `${String(start).slice(-2)}${String(start + 1).slice(-2)}`
  })
}

export function historicalCsvUrl(seasonCode: string, div: string) {
  return `https://www.football-data.co.uk/mmz4281/${seasonCode}/${div}.csv`
}

export const FIXTURES_CSV_URL = 'https://www.football-data.co.uk/fixtures.csv'

export function safeNumber(value: string | undefined): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function sourceFixtureId(div: string, date: string, home: string, away: string) {
  return [div, date, home, away]
    .join('|')
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, '-')
    .replace(/-+/g, '-')
}

function lastSunday(year: number, monthIndex: number) {
  const last = new Date(Date.UTC(year, monthIndex + 1, 0))
  return last.getUTCDate() - last.getUTCDay()
}

function londonOffsetHours(year: number, monthIndex: number, day: number) {
  if (monthIndex < 2 || monthIndex > 9) return 0
  if (monthIndex > 2 && monthIndex < 9) return 1
  if (monthIndex === 2) return day >= lastSunday(year, 2) ? 1 : 0
  return day < lastSunday(year, 9) ? 1 : 0
}

// Football-Data fixture times are treated as UK local time. This keeps storage UTC-safe
// without adding a timezone library to the free-tier ingestion function.
export function ukDateTimeToIso(dateValue: string, timeValue = '12:00') {
  const parts = dateValue.split(/[\/\-]/).map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return null
  const [day, month, yearRaw] = parts
  const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw
  const [hour = 12, minute = 0] = timeValue.split(':').map(Number)
  const offset = londonOffsetHours(year, month - 1, day)
  const utc = Date.UTC(year, month - 1, day, hour - offset, minute, 0)
  const date = new Date(utc)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}
