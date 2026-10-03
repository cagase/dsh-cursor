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
export declare const EFFORT_TOKENS: readonly ["extra-high", "minimal", "medium", "xhigh", "high", "none", "low", "max"];
export declare const EFFORT_NAMES: Readonly<Record<string, string>>;
export interface GrokFamily {
    /** Catalog base slug, e.g. `grok-4.7` or `cursor-grok-4.6`. */
    base: string;
    /**
     * Bare wire form proven accepted for this family (capture §3). It is not
     * always the catalog base: `cursor-grok-4.6-*` needs the `cursor-` prefix in
     * slug form, while the bare form is `grok-4.6`.
     */
    wireBase?: string;
    /** Levels whose `<base>-<level>` slug exists in the catalog. */
    efforts: readonly string[];
    /** Levels whose `<base>-<level>-fast` slug exists in the catalog. */
    fastEfforts: readonly string[];
    /** Effort materialized for this route when the caller omits one. */
    defaultEffort: string;
}
/**
 * The three Grok families exactly as captured (`fixtures/live/models.txt`
 * lines 26–47 and 129–132, plus `fixtures/live/wire-matrix.txt`).
 *
 * `cursor-grok-4.5` supports only low/medium/high: `cursor-grok-4.5-xhigh` is
 * rejected (`fixtures/live/wire/cursor-grok-4.5-xhigh.stderr.txt`), so xhigh is
 * absent here on purpose. No family has a plain `-fast` slug or a `max` level.
 */
export declare const GROK_CAPTURE_FAMILIES: readonly GrokFamily[];
/** Every slug proven acceptable for the three captured families. */
export declare const GROK_CAPTURE_SLUGS: readonly string[];
export interface GrokRoute {
    /** Base slug with any `<effort>` / `-fast` suffix removed. */
    base: string;
    /** The route asked for the Fast twin. */
    fast: boolean;
    /** Effort already encoded in the id, when the id is a full catalog slug. */
    effort?: string;
}
/** True for slugs of the `grok-*` / `cursor-grok-*` families. */
export declare function isGrokModel(id: string): boolean;
/**
 * Split a route id into base/fast/effort. Returns `undefined` for bracketed
 * overrides (caller-supplied passthrough) and non-Grok ids.
 */
export declare function parseGrokRoute(id: string): GrokRoute | undefined;
/**
 * Derive the family matrix from a live `agent models` slug list. Only
 * evidence-backed levels appear: an effort is a valid level exactly when its
 * composed slug is advertised for that base. The capture supplies the accepted
 * bare wire form when the catalog (which lists variants only) cannot.
 */
export declare function grokFamiliesFromSlugs(slugs: readonly string[]): GrokFamily[];
/**
 * Every string the shim may hand to `--model`: the live catalog plus the
 * capture-derived slugs and accepted bare bases. Bracketed overrides are never
 * synthesised, so they stay out of the vocabulary.
 */
export declare function grokSlugVocabulary(liveSlugs?: readonly string[]): Set<string>;
/**
 * Picker order for the Grok families: the captured families first (newest
 * first, as in the capture), then any additional family the live catalog
 * advertises. Live evidence wins for a base the capture already knows.
 */
export declare function grokFamiliesForCatalog(liveSlugs: readonly string[]): GrokFamily[];
/** Family descriptor for one base: the live derivation wins, capture second. */
export declare function grokFamilyFor(base: string, liveSlugs?: readonly string[]): GrokFamily | undefined;
