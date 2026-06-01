/**
 * Google Maps (Places API NEW) source adapter for Agente 2 (Sourcing Scout).
 *
 * Emits `ProviderRaw[]` and NOTHING else — scoring/dedup/persistence happen
 * downstream. Unlike the Instagram/scraping path, Maps does NOT go through Bright
 * Data: it calls Google directly over the n8n VM's egress IP (34.29.82.60, which
 * must be allowlisted on the API key in GCP). The API key comes from
 * `GOOGLE_MAPS_API_KEY` locally (.env) / Secret Manager `leyvascents-gmaps-api-key`
 * in production.
 *
 * --- ENDPOINT ----------------------------------------------------------------
 * POST https://places.googleapis.com/v1/places:searchText  (Places API NEW —
 * NOT the legacy Text Search). Auth is the `X-Goog-Api-Key` header. The
 * `X-Goog-FieldMask` header is REQUIRED on the New API and is what controls cost
 * + payload: we request only the fields we map (see FIELD_MASK). Without it the
 * request is rejected; requesting `*` would bill the most expensive SKU.
 *
 * --- GEOGRAPHIC SCOPING (correction #2) --------------------------------------
 * We scope the search AT THE SOURCE with `locationRestriction`, NOT by pulling
 * all-Mexico results and rectangle-filtering them client-side. Google applies its
 * own boundary knowledge, which cuts noise, payload and cost. IMPORTANT QUIRK of
 * the New Text Search: `locationRestriction` accepts ONLY a `rectangle`
 * (low/high lat-lng) — `circle` is valid for `locationBias` but NOT for
 * `locationRestriction` here. So we send a rectangle covering the ZMVM
 * (Zona Metropolitana del Valle de México). The client-side rectangle check
 * (`withinZmvm`) is kept ONLY as a post-response sanity net for edge results /
 * results missing `location`, never as the primary filter.
 *
 * --- PAGINATION CONTRACT (correction #1, from the Places API NEW docs) --------
 * Verified against Google's documented behavior (no live call made here):
 *   - `pageSize` (max 20) and `pageToken` both go in the request BODY, not the
 *     query string.
 *   - When following a `pageToken`, EVERY other body field (textQuery, pageSize,
 *     locationRestriction, regionCode, languageCode, fieldMask) MUST be identical
 *     to the first request — any drift returns INVALID_ARGUMENT. `searchTextPage`
 *     rebuilds the same base body each call and only adds `pageToken`, so the
 *     bodies are byte-identical by construction.
 *   - `nextPageToken` is NOT guaranteed: the API may stop emitting it before our
 *     `maxPerQuery` cap is reached. We therefore NEVER assume 60 results arrive.
 *     The loop stops cleanly when the token is absent, and if it stops while the
 *     last page was FULL (=== PAGE_SIZE) yet we're still under the cap — i.e. we
 *     "expected more but got no token" — we emit a `warn` so a short result count
 *     is visible in the log rather than silently swallowed.
 *
 * --- COST --------------------------------------------------------------------
 * The New API bills per request (per page). We count every request made and log
 * the total so a run's Maps spend is auditable.
 */

import { ProviderRawSchema, type ProviderRaw } from '../../schemas/provider.schema.js'
import { normalizePhone } from '../dedup.js'

// ---------------------------------------------------------------------------
// Public option / query types
// ---------------------------------------------------------------------------

/**
 * Search-intent tag carried into `raw_signals.query_intent` (NOT a schema field).
 * Lets a downstream step distinguish providers that surfaced under an explicit
 * decant query from those that only surfaced under a generic niche-perfumery
 * query (more likely full-bottle boutiques than decant sellers).
 */
export type QueryIntent = 'decant_explicit' | 'niche_generic'

export interface MapsQuery {
  readonly text: string
  readonly intent: QueryIntent
}

export interface FetchMapsProvidersOptions {
  /** API key. Defaults to `env.GOOGLE_MAPS_API_KEY`. */
  readonly apiKey?: string
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv
  /** Query set. Defaults to `DEFAULT_QUERIES`. */
  readonly queries?: readonly MapsQuery[]
  /** Hard cap on results collected per query (default 60). */
  readonly maxPerQuery?: number
  /** Injectable fetch (default global `fetch`). Tests pass a mock; NO real network in tests. */
  readonly fetchImpl?: typeof fetch
  /** Injectable logger (default `console`). */
  readonly logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLACES_SEARCH_TEXT_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText'

/** Max page size accepted by Text Search (New). 60 results ⇒ up to 3 pages. */
export const PAGE_SIZE = 20

const DEFAULT_MAX_PER_QUERY = 60

/**
 * Field mask: ONLY the fields we map. Place-level fields take the `places.`
 * prefix on Text Search; `nextPageToken` is top-level. Keeping this minimal is
 * what bounds the billed SKU and the payload size.
 */
export const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.rating',
  'places.userRatingCount',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.internationalPhoneNumber',
  'places.location',
  'places.primaryType',
  'nextPageToken',
].join(',')

/**
 * ZMVM rectangle for `locationRestriction` (south-west `low` → north-east
 * `high`). Covers CDMX (centro ~19.43,-99.13) plus the conurbated Estado de
 * México municipios: south to Milpa Alta (~19.0), north past Cuautitlán/Zumpango
 * (~19.85), west to Naucalpan/Huixquilucan (~-99.40), east to Chalco/Texcoco
 * (~-98.85). Deliberately a touch generous — Google's boundary knowledge does the
 * fine filtering; this just bounds the search box.
 */
export const ZMVM_RECTANGLE = {
  low: { latitude: 19.0, longitude: -99.4 },
  high: { latitude: 19.85, longitude: -98.85 },
} as const

/**
 * Default query set (correction #3). Decant-explicit queries are listed FIRST so
 * that, on a place surfacing under more than one query, first-wins dedup keeps
 * the stronger `decant_explicit` intent. The trailing generic niche-perfumery
 * query is tagged `niche_generic`.
 */
export const DEFAULT_QUERIES: readonly MapsQuery[] = [
  { text: 'decants perfume Ciudad de Mexico', intent: 'decant_explicit' },
  { text: 'decants fraccionados CDMX', intent: 'decant_explicit' },
  { text: 'decants importados CDMX', intent: 'decant_explicit' },
  { text: 'muestras perfume nicho Ciudad de Mexico', intent: 'decant_explicit' },
  { text: 'perfume decants Mexico City', intent: 'decant_explicit' },
  { text: 'fragrance decants CDMX', intent: 'decant_explicit' },
  { text: 'perfumeria nicho CDMX', intent: 'niche_generic' },
]

/**
 * Address-text fallback used ONLY for results that came back without a
 * `location` (so `withinZmvm` is inconclusive). Matches the CDMX / Estado de
 * México markers Google puts in `formattedAddress` for the region.
 */
const CDMX_ADDRESS_RE =
  /(ciudad de m[eé]xico|cdmx|distrito federal|estado de m[eé]xico|\bedomex\b|\bm[eé]x\.?\b)/i

// ---------------------------------------------------------------------------
// Minimal shapes of the Places API NEW response (only the masked fields)
// ---------------------------------------------------------------------------

interface GoogleLatLng {
  readonly latitude?: number
  readonly longitude?: number
}

interface GooglePlace {
  readonly id?: string
  readonly displayName?: { readonly text?: string; readonly languageCode?: string }
  readonly formattedAddress?: string
  readonly rating?: number
  readonly userRatingCount?: number
  readonly websiteUri?: string
  readonly nationalPhoneNumber?: string
  readonly internationalPhoneNumber?: string
  readonly location?: GoogleLatLng
  readonly primaryType?: string
}

interface PlacesSearchResponse {
  readonly places?: GooglePlace[]
  readonly nextPageToken?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Defensive redaction: never let the API key survive into a thrown/logged string. */
function redactKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join('***') : text
}

async function safeBodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500)
  } catch {
    return '(unreadable body)'
  }
}

/** One paged `searchText` POST. Body is rebuilt identically each call (+ pageToken). */
async function searchTextPage(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: MapsQuery,
  pageToken: string | undefined,
): Promise<PlacesSearchResponse> {
  // The base body MUST be identical across pages of the same query (New-API
  // pageToken contract) — only `pageToken` is added when continuing.
  const body: Record<string, unknown> = {
    textQuery: query.text,
    regionCode: 'MX',
    languageCode: 'es',
    pageSize: PAGE_SIZE,
    locationRestriction: { rectangle: ZMVM_RECTANGLE },
  }
  if (pageToken) body.pageToken = pageToken

  const res = await fetchImpl(PLACES_SEARCH_TEXT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = redactKey(await safeBodyText(res), apiKey)
    throw new Error(
      `fetchMapsProviders: Places API searchText HTTP ${res.status} ${res.statusText} ` +
        `for query "${query.text}". This is commonly a bad/disabled API key, a 403 from an ` +
        `IP not on the key's allowlist (egress must be 34.29.82.60), or quota exhaustion. ` +
        `Response: ${detail}`,
    )
  }

  return (await res.json()) as PlacesSearchResponse
}

/** Page through one query up to `maxPerQuery`, accounting requests + logging the count. */
async function fetchPlacesForQuery(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: MapsQuery,
  maxPerQuery: number,
  log: Pick<Console, 'log' | 'warn' | 'error'>,
): Promise<{ places: GooglePlace[]; requests: number }> {
  const collected: GooglePlace[] = []
  let pageToken: string | undefined
  let requests = 0

  while (collected.length < maxPerQuery) {
    const resp = await searchTextPage(fetchImpl, apiKey, query, pageToken)
    requests += 1
    const pagePlaces = resp.places ?? []
    collected.push(...pagePlaces)
    pageToken = resp.nextPageToken

    if (!pageToken) {
      // No token. If the last page was FULL but we're still under the cap, the
      // API stopped paginating earlier than the cap suggested — surface it.
      if (pagePlaces.length === PAGE_SIZE && collected.length < maxPerQuery) {
        log.warn(
          `[maps-source] query "${query.text}": no nextPageToken after ${collected.length} result(s) ` +
            `despite a full last page — Places API stopped paginating before the ${maxPerQuery} cap.`,
        )
      }
      break
    }
  }

  const trimmed = collected.slice(0, maxPerQuery)
  log.log(
    `[maps-source] query "${query.text}" [${query.intent}]: ${trimmed.length} place(s) over ${requests} request(s)`,
  )
  return { places: trimmed, requests }
}

/** 'in' / 'out' of the ZMVM rectangle, or 'unknown' when the place has no coords. */
function withinZmvm(place: GooglePlace): 'in' | 'out' | 'unknown' {
  const lat = place.location?.latitude
  const lng = place.location?.longitude
  if (typeof lat !== 'number' || typeof lng !== 'number') return 'unknown'
  const inBox =
    lat >= ZMVM_RECTANGLE.low.latitude &&
    lat <= ZMVM_RECTANGLE.high.latitude &&
    lng >= ZMVM_RECTANGLE.low.longitude &&
    lng <= ZMVM_RECTANGLE.high.longitude
  return inBox ? 'in' : 'out'
}

/** Map a Google place to a validated `ProviderRaw`, or null when unmappable. */
function mapPlaceToRaw(place: GooglePlace, query: MapsQuery): ProviderRaw | null {
  const id = place.id?.trim()
  const name = place.displayName?.text?.trim()
  // source_id and name are both non-empty by schema; a place missing either is
  // malformed and cannot be represented — skip it rather than throw the run.
  if (!id || !name) return null

  const phoneRaw = place.nationalPhoneNumber ?? place.internationalPhoneNumber ?? null
  const normalizedPhone = phoneRaw ? normalizePhone(phoneRaw) : ''
  const whatsapp = normalizedPhone !== '' ? normalizedPhone : null

  const formattedAddress = place.formattedAddress?.trim() ?? ''

  const raw: ProviderRaw = {
    source: 'maps',
    source_id: id,
    name,
    whatsapp,
    instagram_handle: null, // Maps does not expose IG
    catalog_url: place.websiteUri?.trim() || null,
    rating: typeof place.rating === 'number' ? place.rating : null,
    reviews_count: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    account_age_days: null, // Maps does not expose account/listing age
    detected_brands: [], // Maps gives no catalog; enriched by another source or left empty
    has_physical_address: formattedAddress !== '',
    refund_policy_explicit: false, // Maps does not expose this
    raw_signals: {
      google_place_id: id,
      primary_type: place.primaryType ?? null,
      location: place.location ?? null,
      formatted_address: formattedAddress || null,
      query: query.text,
      query_intent: query.intent,
    },
  }

  // parse (not safeParse): a mapping that violates the contract is a bug here.
  return ProviderRawSchema.parse(raw)
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Discover CDMX/ZMVM decant & niche-perfume providers via Google Places (New)
 * Text Search and emit them as `ProviderRaw[]`.
 *
 * - Scopes each search with `locationRestriction` (ZMVM rectangle); applies the
 *   client-side rectangle/text check only as a post-response sanity net.
 * - Dedupes by Google place id within this call (first occurrence wins; the
 *   decant-explicit queries run first so they win over the generic one). Cross-
 *   source dedup by phone/handle is dedup.ts's job downstream.
 * - Validates every emitted record with `ProviderRawSchema`.
 * - Throws loudly on a missing key or a non-2xx (403 / quota) response.
 */
export async function fetchMapsProviders(
  opts: FetchMapsProvidersOptions = {},
): Promise<ProviderRaw[]> {
  const env = opts.env ?? process.env
  const apiKey = (opts.apiKey ?? env.GOOGLE_MAPS_API_KEY ?? '').trim()
  if (!apiKey) {
    throw new Error(
      'fetchMapsProviders: missing GOOGLE_MAPS_API_KEY. Set it in a local .env ' +
        '(see .env.example) or inject it from GCP Secret Manager (leyvascents-gmaps-api-key). ' +
        'The key must allow the egress IP 34.29.82.60 and have the Places API (New) enabled.',
    )
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const queries = opts.queries ?? DEFAULT_QUERIES
  const maxPerQuery = opts.maxPerQuery ?? DEFAULT_MAX_PER_QUERY
  const log = opts.logger ?? console

  const byPlaceId = new Map<string, ProviderRaw>()
  let totalRequests = 0
  let droppedOutOfArea = 0

  for (const query of queries) {
    const { places, requests } = await fetchPlacesForQuery(fetchImpl, apiKey, query, maxPerQuery, log)
    totalRequests += requests

    for (const place of places) {
      const verdict = withinZmvm(place)
      if (verdict === 'out') {
        droppedOutOfArea += 1
        continue
      }
      if (verdict === 'unknown' && !CDMX_ADDRESS_RE.test(place.formattedAddress ?? '')) {
        // No coords AND no CDMX/Edomex address marker — cannot confirm it's in area.
        droppedOutOfArea += 1
        continue
      }

      const raw = mapPlaceToRaw(place, query)
      if (raw === null) continue

      // First-wins dedup: decant_explicit queries run first, so they take priority.
      if (!byPlaceId.has(raw.source_id)) byPlaceId.set(raw.source_id, raw)
    }
  }

  log.log(
    `[maps-source] done: ${byPlaceId.size} unique provider(s), ${droppedOutOfArea} dropped out-of-area, ` +
      `${totalRequests} total Places API request(s) (billed).`,
  )

  return [...byPlaceId.values()]
}
