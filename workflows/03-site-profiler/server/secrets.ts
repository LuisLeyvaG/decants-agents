/**
 * secrets — load the runtime secrets Agente 3 (Site Profiler) needs, from GCP
 * Secret Manager, using the VM's Service Account (leyvascents-n8n-sa) that the
 * container inherits from the instance metadata server via ADC. Calques
 * 02-sourcing-scout/server/secrets.ts.
 *
 * A3 reads more than A2: its OWN OpenAI key, the agents Postgres URL, and the
 * three Bright Data credentials A3/A4 use to fetch storefronts through the proxy.
 *
 * NOT here: the Bright Data CA certificate is NOT a secret — it is a public root
 * baked into the image under certs/ and referenced BY PATH by the fetch layer,
 * never loaded from Secret Manager.
 *
 * IAM note: the VM SA has roles/secretmanager.secretAccessor granted PER-SECRET
 * (project-wide it only has viewer). Each of the five names below MUST carry an
 * explicit accessor binding for the VM SA — in particular the new
 * leyvascents-site-profiler-openai-api-key — or the access() call here 403s. See
 * the deploy notes for the `gcloud secrets add-iam-policy-binding` commands.
 *
 * Opsec: secret VALUES are returned to the caller and never logged. This module
 * logs only secret NAMES and success/failure — never a payload, not even a prefix.
 */

import { SecretManagerServiceClient } from '@google-cloud/secret-manager'

// ---------------------------------------------------------------------------
// Secret names — single source of truth. Values are uploaded out-of-band by the
// operator; this code only references them by name.
// ---------------------------------------------------------------------------

/** GCP project that owns the secrets. Overridable for non-prod, defaults to prod. */
const GCP_PROJECT = process.env.GCP_PROJECT ?? 'leyva-scents'

/** A3's OWN OpenAI key (distinct from A1/A2's keys and the backend's). */
export const SECRET_OPENAI_API_KEY = 'leyvascents-site-profiler-openai-api-key'

/** Full connection string to postgres-agents. */
export const SECRET_POSTGRES_URL = 'leyvascents-agents-postgres-url'

/** Bright Data proxy endpoint (host:port). */
export const SECRET_BRIGHTDATA_ENDPOINT = 'leyvascents-brightdata-endpoint'
/** Bright Data proxy username. */
export const SECRET_BRIGHTDATA_USERNAME = 'leyvascents-brightdata-username'
/** Bright Data proxy password. */
export const SECRET_BRIGHTDATA_PASSWORD = 'leyvascents-brightdata-password'

export interface RuntimeSecrets {
  readonly openaiApiKey: string
  readonly postgresUrl: string
  readonly brightdataEndpoint: string
  readonly brightdataUsername: string
  readonly brightdataPassword: string
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** Read the `latest` version of one secret. Throws a loud, value-free error on failure. */
async function accessSecret(
  client: SecretManagerServiceClient,
  name: string,
): Promise<string> {
  const resource = `projects/${GCP_PROJECT}/secrets/${name}/versions/latest`
  let payload: string | undefined
  try {
    const [version] = await client.accessSecretVersion({ name: resource })
    // data is a Buffer | string | null; coerce to utf8 string.
    const data = version.payload?.data
    payload = data == null ? undefined : Buffer.from(data as Uint8Array).toString('utf8')
  } catch (e) {
    // The error from the client carries the resource NAME (safe) but never the
    // value (there is none yet). Surface it so a 403 / NOT_FOUND is diagnosable.
    throw new Error(
      `Failed to read secret "${name}" from Secret Manager (project ${GCP_PROJECT}). ` +
        `Check the secret exists and the VM SA has roles/secretmanager.secretAccessor ` +
        `bound on it. Underlying error: ${(e as Error).message}`,
    )
  }
  if (payload === undefined || payload.trim() === '') {
    throw new Error(`Secret "${name}" is empty or has no accessible version — aborting.`)
  }
  return payload.trim()
}

/**
 * Load every secret the process needs, FAILING LOUDLY (and early, at startup) if
 * any is missing or unreadable — we never want the container to come up half-
 * configured and only discover a missing secret on the first /run.
 */
export async function loadSecrets(): Promise<RuntimeSecrets> {
  const client = new SecretManagerServiceClient()
  // Sequential: a clear failure order aids diagnosis. Names are logged; values never are.
  const openaiApiKey = await accessSecret(client, SECRET_OPENAI_API_KEY)
  const postgresUrl = await accessSecret(client, SECRET_POSTGRES_URL)
  const brightdataEndpoint = await accessSecret(client, SECRET_BRIGHTDATA_ENDPOINT)
  const brightdataUsername = await accessSecret(client, SECRET_BRIGHTDATA_USERNAME)
  const brightdataPassword = await accessSecret(client, SECRET_BRIGHTDATA_PASSWORD)
  return {
    openaiApiKey,
    postgresUrl,
    brightdataEndpoint,
    brightdataUsername,
    brightdataPassword,
  }
}
