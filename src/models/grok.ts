/**
 * Grok-family route vocabulary for the Cursor `agent` CLI.
 *
 * Ground truth is the live capture, never a re-derivation:
 *   docs/live-cli-contract.md §2 (Grok matrix) and §3 (wire acceptance)
 *   fixtures/live/models.txt      — the 22 catalog slugs of the three families
 *   fixtures/live/wire-matrix.txt — bare bases accepted; `-fast` without an
 *                                   effort rejected; no max/minimal variants
 *
 * The DSH picker publishes one route per family base plus its own `<base>-fast`
 * route (DSH has no boolean model parameter). Every string the shim hands to
 * `--model` is composed from this vocabulary. Nothing here synthesises a
 * `base[param=value]` override: §3.2 proves those are rejected for Grok, and
 * the CLI's own advertised bracket example is rejected for this account too.
 */

/** Effort tokens observed in the catalog, longest first for suffix matching. */
export const EFFORT_TOKENS = [
  'extra-high',
  'minimal',
  'medium',
  'xhigh',
  'high',
  'none',
  'low',
  'max',
] as const

export const EFFORT_NAMES: Readonly<Record<string, string>> = {
  'extra-high': 'Extra High',
  xhigh: 'Extra High',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  minimal: 'Minimal',
  none: 'Off',
  max: 'Max',
}

export interface GrokFamily {
  /** Catalog base slug, e.g. `grok-4.7` or `cursor-grok-4.6`. */
  base: string
  /**
   * Bare wire form proven accepted for this family (capture §3). It is not
   * always the catalog base: `cursor-grok-4.6-*` needs the `cursor-` prefix in
   * slug form, while the bare form is `grok-4.6`.
   */
  wireBase?: string
  /** Levels whose `<base>-<level>` slug exists in the catalog. */
  efforts: readonly string[]
  /** Levels whose `<base>-<level>-fast` slug exists in the catalog. */
  fastEfforts: readonly string[]
  /** Effort materialized for this route when the caller omits one. */
  defaultEffort: string
}

/**
 * The three Grok families exactly as captured (`fixtures/live/models.txt`
 * lines 26–47 and 129–132, plus `fixtures/live/wire-matrix.txt`).
 *
 * `cursor-grok-4.5` supports only low/medium/high: `cursor-grok-4.5-xhigh` is
 * rejected (`fixtures/live/wire/cursor-grok-4.5-xhigh.stderr.txt`), so xhigh is
 * absent here on purpose. No family has a plain `-fast` slug or a `max` level.
 */
export const GROK_CAPTURE_FAMILIES: readonly GrokFamily[] = [
  {
    base: 'grok-4.7',
    wireBase: 'grok-4.7',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    fastEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    base: 'cursor-grok-4.6',
    wireBase: 'grok-4.6',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    fastEfforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
  },
  {
    base: 'cursor-grok-4.5',
    wireBase: 'grok-4.5',
    efforts: ['low', 'medium', 'high'],
    fastEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
  },
] as const

/** Every slug proven acceptable for the three captured families. */
export const GROK_CAPTURE_SLUGS: readonly string[] = (() => {
  const out: string[] = []
  for (const family of GROK_CAPTURE_FAMILIES) {
    if (family.wireBase) out.push(family.wireBase)
    for (const effort of family.efforts) out.push(`${family.base}-${effort}`)
    for (const effort of family.fastEfforts) out.push(`${family.base}-${effort}-fast`)
  }
  return out
})()

export interface GrokRoute {
  /** Base slug with any `<effort>` / `-fast` suffix removed. */
  base: string
  /** The route asked for the Fast twin. */
  fast: boolean
  /** Effort already encoded in the id, when the id is a full catalog slug. */
  effort?: string
}

/** True for slugs of the `grok-*` / `cursor-grok-*` families. */
export function isGrokModel(id: string): boolean {
  return /^(?:cursor-)?grok(?:$|-)/.test(id.trim())
}

/**
 * Split a route id into base/fast/effort. Returns `undefined` for bracketed
 * overrides (caller-supplied passthrough) and non-Grok ids.
 */
export function parseGrokRoute(id: string): GrokRoute | undefined {
  const trimmed = id.trim()
  if (trimmed === '' || trimmed.includes('[')) return undefined
  if (!isGrokModel(trimmed)) return undefined
  let rest = trimmed
  let fast = false
  if (rest.endsWith('-fast')) {
    fast = true
    rest = rest.slice(0, -'-fast'.length)
  }
  let effort: string | undefined
  for (const token of EFFORT_TOKENS) {
    if (!rest.endsWith(`-${token}`)) continue
    effort = token
    rest = rest.slice(0, -(token.length + 1))
    break
  }
  const base = rest === '' ? trimmed : rest
  return effort === undefined ? { base, fast } : { base, fast, effort }
}

/**
 * Derive the family matrix from a live `agent models` slug list. Only
 * evidence-backed levels appear: an effort is a valid level exactly when its
 * composed slug is advertised for that base. The capture supplies the accepted
 * bare wire form when the catalog (which lists variants only) cannot.
 */
export function grokFamiliesFromSlugs(slugs: readonly string[]): GrokFamily[] {
  const found = new Map<string, { efforts: Set<string>; fastEfforts: Set<string>; bare: boolean }>()
  for (const raw of slugs) {
    const slug = raw.trim()
    if (slug === '' || slug.includes('[')) continue
    const route = parseGrokRoute(slug)
    if (!route) continue
    let entry = found.get(route.base)
    if (!entry) {
      entry = { efforts: new Set(), fastEfforts: new Set(), bare: false }
      found.set(route.base, entry)
    }
    if (route.effort !== undefined) (route.fast ? entry.fastEfforts : entry.efforts).add(route.effort)
    else if (!route.fast) entry.bare = true
  }
  const families: GrokFamily[] = []
  for (const [base, entry] of found) {
    if (entry.efforts.size === 0 && entry.fastEfforts.size === 0 && !entry.bare) continue
    const capture = GROK_CAPTURE_FAMILIES.find((family) => family.base === base)
    const wireBase = entry.bare ? base : capture?.wireBase
    families.push({
      base,
      ...wireBase === undefined ? {} : { wireBase },
      efforts: [...entry.efforts].sort(compareEffort),
      fastEfforts: [...entry.fastEfforts].sort(compareEffort),
      defaultEffort: entry.efforts.has('high') ? 'high' : entry.efforts.values().next().value ?? 'high',
    })
  }
  return families
}

/** Display order for derived families (weakest to strongest). */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max']

function compareEffort(left: string, right: string): number {
  return EFFORT_ORDER.indexOf(left) - EFFORT_ORDER.indexOf(right)
}

/**
 * Every string the shim may hand to `--model`: the live catalog plus the
 * capture-derived slugs and accepted bare bases. Bracketed overrides are never
 * synthesised, so they stay out of the vocabulary.
 */
export function grokSlugVocabulary(liveSlugs: readonly string[] = []): Set<string> {
  const vocabulary = new Set<string>()
  for (const raw of liveSlugs) {
    const slug = raw.trim()
    if (slug === '' || slug.includes('[')) continue
    vocabulary.add(slug)
  }
  for (const slug of GROK_CAPTURE_SLUGS) vocabulary.add(slug)
  for (const family of grokFamiliesFromSlugs(liveSlugs)) {
    if (family.wireBase) vocabulary.add(family.wireBase)
    for (const effort of family.efforts) vocabulary.add(`${family.base}-${effort}`)
    for (const effort of family.fastEfforts) vocabulary.add(`${family.base}-${effort}-fast`)
  }
  return vocabulary
}

/**
 * Picker order for the Grok families: the captured families first (newest
 * first, as in the capture), then any additional family the live catalog
 * advertises. Live evidence wins for a base the capture already knows.
 */
export function grokFamiliesForCatalog(liveSlugs: readonly string[]): GrokFamily[] {
  const derived = new Map(grokFamiliesFromSlugs(liveSlugs).map((family) => [family.base, family]))
  const families: GrokFamily[] = []
  for (const capture of GROK_CAPTURE_FAMILIES) {
    families.push(derived.get(capture.base) ?? capture)
    derived.delete(capture.base)
  }
  for (const extra of derived.values()) families.push(extra)
  return families
}

/** Family descriptor for one base: the live derivation wins, capture second. */
export function grokFamilyFor(base: string, liveSlugs: readonly string[] = []): GrokFamily | undefined {
  const live = grokFamiliesFromSlugs(liveSlugs).find((family) => family.base === base)
  if (live) return live
  return GROK_CAPTURE_FAMILIES.find((family) => family.base === base)
}
