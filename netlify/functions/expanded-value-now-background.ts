import expandedValueEngine from './expanded-value-engine'

export default async () => {
  const response = await expandedValueEngine()
  if (!response.ok) throw new Error(`Expanded value engine failed: ${await response.text()}`)
}
