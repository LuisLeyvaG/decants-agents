/**
 * Unit tests for the Google Maps (Places API NEW) source adapter.
 *
 * No real network: `fetchImpl` is mocked and returns Response-shaped fakes. The
 * contract under test: each Google place maps to a schema-valid `ProviderRaw`,
 * nulls are produced where the source is silent, out-of-area results are dropped
 * by the post-response sanity net, pagination follows `nextPageToken` with an
 * identical body, results dedupe by place id, and key/HTTP failures throw.
 */

import { jest } from '@jest/globals'

import { ProviderRawSchema } from '../schemas/provider.schema.js'
import {
  FIELD_MASK,
  PLACES_SEARCH_TEXT_ENDPOINT,
  fetchMapsProviders,
  type MapsQuery,
} from '../scripts/sources/maps-source.js'

// --- fake Response builder --------------------------------------------------

function jsonResponse(
  payload: unknown,
  init: { ok?: boolean; status?: number; statusText?: string } = {},
): Response {
  const { ok = true, status = 200, statusText = 'OK' } = init
  return {
    ok,
    status,
    statusText,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

/** Minimal shape we use off the fetch mock — avoids the jest-version-specific generic form. */
interface FetchMock {
  (url: string, init: RequestInit): Promise<Response>
  readonly mock: { readonly calls: ReadonlyArray<[string, RequestInit]> }
  mockResolvedValueOnce(r: Response): FetchMock
}

/** A fetch mock that returns the queued responses in order. */
function fetchReturning(...responses: Response[]): FetchMock {
  const fn = jest.fn() as unknown as FetchMock
  for (const r of responses) fn.mockResolvedValueOnce(r)
  return fn
}

/** Silent logger so test output stays clean; spied where assertions need it. */
function silentLogger() {
  return { log: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

const ONE_QUERY: readonly MapsQuery[] = [
  { text: 'decants perfume Ciudad de Mexico', intent: 'decant_explicit' },
]

// Centro de CDMX — inside the ZMVM rectangle.
const CDMX_LOCATION = { latitude: 19.4326, longitude: -99.1332 }

const COMPLETE_PLACE = {
  id: 'ChIJ_complete_001',
  displayName: { text: 'Decants MX Polanco', languageCode: 'es' },
  formattedAddress: 'Av. Presidente Masaryk 100, Polanco, Ciudad de México, CDMX',
  rating: 4.7,
  userRatingCount: 213,
  websiteUri: 'https://decantsmx.example',
  nationalPhoneNumber: '55 1234 5678',
  internationalPhoneNumber: '+52 55 1234 5678',
  location: CDMX_LOCATION,
  primaryType: 'perfume_store',
}

const API_KEY = 'test-key-abc'

describe('fetchMapsProviders — mapping', () => {
  it('maps a complete place into a fully-populated, schema-valid ProviderRaw', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ places: [COMPLETE_PLACE] }))

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(out).toHaveLength(1)
    const p = out[0]!
    expect(p).toMatchObject({
      source: 'maps',
      source_id: 'ChIJ_complete_001',
      name: 'Decants MX Polanco',
      whatsapp: '5512345678', // normalizePhone applied (no +52, no spaces)
      instagram_handle: null,
      catalog_url: 'https://decantsmx.example',
      rating: 4.7,
      reviews_count: 213,
      account_age_days: null,
      detected_brands: [],
      has_physical_address: true,
      refund_policy_explicit: false,
    })
    expect(p.raw_signals).toMatchObject({
      google_place_id: 'ChIJ_complete_001',
      primary_type: 'perfume_store',
      query: 'decants perfume Ciudad de Mexico',
      query_intent: 'decant_explicit',
    })
    // every emitted record validates against the schema
    expect(ProviderRawSchema.safeParse(p).success).toBe(true)
  })

  it('sends regionCode/languageCode/locationRestriction in the body and the field mask + key in headers', async () => {
    const fetchImpl = fetchReturning(jsonResponse({ places: [COMPLETE_PLACE] }))

    await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(PLACES_SEARCH_TEXT_ENDPOINT)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Goog-Api-Key']).toBe(API_KEY)
    expect(headers['X-Goog-FieldMask']).toBe(FIELD_MASK)
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({
      textQuery: 'decants perfume Ciudad de Mexico',
      regionCode: 'MX',
      languageCode: 'es',
      pageSize: 20,
    })
    // location scoped AT THE SOURCE via a rectangle (New API: restriction is rectangle-only)
    expect(body.locationRestriction.rectangle).toBeDefined()
    expect(body.locationRestriction.rectangle.low).toBeDefined()
    expect(body.locationRestriction.rectangle.high).toBeDefined()
    expect(body.pageToken).toBeUndefined() // first page carries no token
  })

  it('produces nulls (not crashes) when phone / rating / website are absent', async () => {
    const sparse = {
      id: 'ChIJ_sparse_002',
      displayName: { text: 'Perfumería Sin Datos' },
      formattedAddress: 'Calle Falsa 123, Coyoacán, Ciudad de México, CDMX',
      location: CDMX_LOCATION,
      primaryType: 'store',
      // no rating, no userRatingCount, no websiteUri, no phone numbers
    }
    const fetchImpl = fetchReturning(jsonResponse({ places: [sparse] }))

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source_id: 'ChIJ_sparse_002',
      whatsapp: null,
      catalog_url: null,
      rating: null,
      reviews_count: null,
      has_physical_address: true, // address present
    })
    expect(ProviderRawSchema.safeParse(out[0]).success).toBe(true)
  })
})

describe('fetchMapsProviders — geographic sanity net', () => {
  it('drops a place whose coords fall outside the ZMVM rectangle', async () => {
    const monterrey = {
      ...COMPLETE_PLACE,
      id: 'ChIJ_mty_003',
      displayName: { text: 'Decants Monterrey' },
      formattedAddress: 'Av. Constitución 100, Monterrey, Nuevo León',
      location: { latitude: 25.6866, longitude: -100.3161 },
    }
    const fetchImpl = fetchReturning(jsonResponse({ places: [monterrey] }))

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(out).toHaveLength(0)
  })

  it('keeps a place with no coords when its address matches a CDMX marker', async () => {
    const noCoords = {
      id: 'ChIJ_nocoords_004',
      displayName: { text: 'Decants Sin Coords' },
      formattedAddress: 'Roma Norte, Ciudad de México, CDMX',
      primaryType: 'store',
      // no location
    }
    const fetchImpl = fetchReturning(jsonResponse({ places: [noCoords] }))

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(out).toHaveLength(1)
    expect(out[0]!.source_id).toBe('ChIJ_nocoords_004')
  })

  it('drops a place with neither coords nor a CDMX address marker', async () => {
    const ambiguous = {
      id: 'ChIJ_ambiguous_005',
      displayName: { text: 'Tienda Ambigua' },
      formattedAddress: 'Guadalajara, Jalisco',
      primaryType: 'store',
    }
    const fetchImpl = fetchReturning(jsonResponse({ places: [ambiguous] }))

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(out).toHaveLength(0)
  })
})

describe('fetchMapsProviders — pagination', () => {
  it('follows nextPageToken and concatenates pages, sending an identical body + the token', async () => {
    const place1 = { ...COMPLETE_PLACE, id: 'ChIJ_page1' }
    const place2 = { ...COMPLETE_PLACE, id: 'ChIJ_page2' }
    const fetchImpl = fetchReturning(
      jsonResponse({ places: [place1], nextPageToken: 'TOKEN_A' }),
      jsonResponse({ places: [place2] }), // no token → stop
    )

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out.map((p) => p.source_id)).toEqual(['ChIJ_page1', 'ChIJ_page2'])

    const firstBody = JSON.parse(fetchImpl.mock.calls[0]![1].body as string)
    const secondBody = JSON.parse(fetchImpl.mock.calls[1]![1].body as string)
    // identical base body; second only adds pageToken (New-API contract)
    expect(secondBody.pageToken).toBe('TOKEN_A')
    const { pageToken: _omit, ...secondBase } = secondBody
    expect(secondBase).toEqual(firstBody)
  })

  it('warns when a full last page arrives without a nextPageToken below the cap', async () => {
    const fullPage = Array.from({ length: 20 }, (_, i) => ({
      ...COMPLETE_PLACE,
      id: `ChIJ_full_${i}`,
    }))
    // full page (20) but no token, while maxPerQuery (default 60) not reached
    const fetchImpl = fetchReturning(jsonResponse({ places: fullPage }))
    const logger = silentLogger()

    await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger,
    })

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn.mock.calls[0]![0]).toContain('no nextPageToken')
  })

  it('respects maxPerQuery and stops paging once the cap is reached', async () => {
    const pageOf = (prefix: string) =>
      Array.from({ length: 20 }, (_, i) => ({ ...COMPLETE_PLACE, id: `${prefix}_${i}` }))
    const fetchImpl = fetchReturning(
      jsonResponse({ places: pageOf('a'), nextPageToken: 'T1' }),
      jsonResponse({ places: pageOf('b'), nextPageToken: 'T2' }),
      // a third page exists, but cap=40 should stop us before requesting it
      jsonResponse({ places: pageOf('c'), nextPageToken: 'T3' }),
    )

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries: ONE_QUERY,
      maxPerQuery: 40,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(out).toHaveLength(40)
  })
})

describe('fetchMapsProviders — dedup', () => {
  it('dedupes the same place id surfacing across two queries', async () => {
    const shared = { ...COMPLETE_PLACE, id: 'ChIJ_shared' }
    const queries: MapsQuery[] = [
      { text: 'decants fraccionados CDMX', intent: 'decant_explicit' },
      { text: 'perfumeria nicho CDMX', intent: 'niche_generic' },
    ]
    const fetchImpl = fetchReturning(
      jsonResponse({ places: [shared] }),
      jsonResponse({ places: [shared] }),
    )

    const out = await fetchMapsProviders({
      apiKey: API_KEY,
      queries,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: silentLogger(),
    })

    expect(out).toHaveLength(1)
    // first-wins: the decant_explicit query ran first, so its intent is retained
    expect(out[0]!.raw_signals.query_intent).toBe('decant_explicit')
  })
})

describe('fetchMapsProviders — errors', () => {
  it('throws a clear error when the API key is missing', async () => {
    await expect(
      fetchMapsProviders({
        apiKey: '',
        env: {},
        queries: ONE_QUERY,
        fetchImpl: fetchReturning() as unknown as typeof fetch,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/GOOGLE_MAPS_API_KEY/)
  })

  it('throws on a 403 (e.g. IP not allowlisted / quota), not silently', async () => {
    const fetchImpl = fetchReturning(
      jsonResponse({ error: { status: 'PERMISSION_DENIED' } }, { ok: false, status: 403, statusText: 'Forbidden' }),
    )

    await expect(
      fetchMapsProviders({
        apiKey: API_KEY,
        queries: ONE_QUERY,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: silentLogger(),
      }),
    ).rejects.toThrow(/HTTP 403/)
  })
})
