# `02-sourcing-scout/schemas/` — notes for maintainers

## `sourcing-scout-output.schema.json` — OpenAI Structured Outputs strict envelope

This is the **hand-maintained** JSON Schema sent to the OpenAI Responses API as
`text.format = { type: 'json_schema', ...thisFile }`. It is NOT generated from
`provider.schema.ts` (unlike Agente 1, whose JSON is built by
`scripts/build-output-schema.ts`).

### Why there is no `"format": "uri"` (do not re-add it)

`catalog_url` and `evidence_urls.items` are plain `{ "type": "string" }` — they
deliberately carry **no** `"format": "uri"`.

OpenAI Structured Outputs **strict mode rejects** `format: "uri"` with an HTTP 400
`invalid_json_schema` ("'uri' is not a valid format"). Strict mode only accepts a
small format allow-list (`date-time`, `date`, `time`, `duration`, `email`,
`hostname`, `ipv4`, `ipv6`, `uuid`). This was found the hard way by the 2R.4a
calibration smoke (`scripts/smoke-sourcing.ts`): both runs failed at request
validation, before any completion.

Removing the format is **safe** because URL-format validation is enforced
deterministically downstream, not by this strict contract:

- `ProviderRawSchema.catalog_url` is `z.string().url()` (`provider.schema.ts`).
- `ProviderRawSchema.evidence_urls` is `z.array(z.string().url())` — the `.url()`
  is inside the array, so **every item** is format-checked, not just the
  cardinality.
- `validateAndFilter` runs `ProviderRawSchema.safeParse(raw)` as its first rule;
  a non-URL `catalog_url` or any non-URL `evidence_urls` item lands in
  `rejected` with `reason: 'schema_invalid'`.

So the `format: "uri"` in the strict contract was redundant with the filter AND
incompatible with OpenAI. The real guarantee lives in Zod + `validateAndFilter`.

### Anti-drift caveat — if this JSON is ever generated from Zod (2R.x)

Zod v4's `z.toJSONSchema(ProviderRawSchema)` emits `"format": "uri"` for every
`.url()` field. If a future sprint switches this file to a generated artifact
(mirroring A1's `build-output-schema.ts`), the generator **must post-process the
output to strip `format: "uri"`** (the same way A1's builder normalizes for
OpenAI strict mode), or the request will start failing with HTTP 400 again.
