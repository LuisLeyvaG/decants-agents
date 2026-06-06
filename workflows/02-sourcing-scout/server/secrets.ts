/**
 * secrets — load the runtime secrets Agente 2 needs, from GCP Secret Manager,
 * using the VM's Service Account (leyvascents-n8n-sa) that the container inherits
 * from the instance metadata server via ADC.
 *
 * WHY Secret Manager and not an .env / n8n credential:
 *   The container runs the REAL pipeline (OpenAI + Postgres) on the VM, where
 *   the only authenticated identity is the VM SA. A1's pattern (key inside an n8n
 *   credential) does not reach this process. So A2 reads its own secrets directly
 *   at startup. @google-cloud/secret-manager picks up ADC automatically — no key
 *   file, no env-var secret.
 *
 * IAM note (verified at design time): the VM SA has `secretmanager.secretAccessor`
 * granted PER-SECRET (not project-wide; project-wide it only has `viewer`). The
 * two secret names below MUST each carry an explicit accessor binding for the VM
 * SA, or the access() call here 403s. See TODO.md / the deploy notes for the
 * `gcloud secrets add-iam-policy-binding` commands.
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

/** A2's OWN OpenAI key (distinct from leyvascents-openai-api-key, which the backend uses). */
export const SECRET_OPENAI_API_KEY = 'leyvascents-sourcing-scout-openai-api-key'

/** Full connection string to postgres-agents, e.g. postgresql://agents:***@postgres-agents:5432/agents */
export const SECRET_POSTGRES_URL = 'leyvascents-agents-postgres-url'

export interface RuntimeSecrets {
  readonly openaiApiKey: string
  readonly postgresUrl: string
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
  // Sequential is fine: two reads at boot, and a clear failure order aids
  // diagnosis. Names are logged; values never are.
  const openaiApiKey = await accessSecret(client, SECRET_OPENAI_API_KEY)
  const postgresUrl = await accessSecret(client, SECRET_POSTGRES_URL)
  return { openaiApiKey, postgresUrl }
}
