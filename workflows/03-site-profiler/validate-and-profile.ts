/**
 * validate-and-profile — pure resolution of a Site Profiler (A3) recipe's
 * lifecycle status from the two cross-field rules the Zod contract
 * (schemas/site-recipe.schema.ts) documents but deliberately does NOT enforce.
 * The A3 mirror of 02-sourcing-scout/validate-and-filter.ts, adapted to the
 * single-recipe shape.
 *
 * A2 partitions a whole-run ENVELOPE ({ providers: [...] }) of many candidates;
 * A3 profiles ONE site and emits ONE recipe (agent.site_recipes is UNIQUE per
 * provider), so there is no array, no per-item loop, and no envelope-level
 * parse_failed abort. The input is the SiteRecipe the model emitted, ALREADY
 * structurally validated by SiteRecipeSchema upstream; this function applies the
 * business rules Zod left open and re-derives recipe_status WITH A FLOOR.
 *
 * RULE 1 — validity (structural): a recipe is 'active' ONLY if all three
 *   mandatory selectors (title, price, stock) are present with a non-empty
 *   `selector`. If any is missing/degenerate → 'failed'. PURELY structural: A3
 *   cannot verify a selector truly points at stock without executing it — that is
 *   A4's job. SiteRecipeSchema already guarantees this for Zod-valid input; the
 *   check is kept explicit and defensive, mirroring how A2 re-runs its per-item
 *   schema rather than trusting prior validation.
 *
 * RULE 2 — attribute (cross-field): any FieldSelector with source = 'attribute'
 *   MUST carry a non-empty `attribute_name`, else it is unexecutable and the
 *   recipe is 'failed'. Applies to ALL SIX slots, not just the mandatory three.
 *   Zod allows attribute_name = null regardless of source on purpose (so the
 *   model emits the honest null for text/json sources), so THIS is the genuine
 *   rule Zod left to code — A3's analogue of A2's non-empty evidence_urls gate.
 *
 * NOT a status input: extraction_confidence = 'low' on a mandatory selector does
 *   NOT degrade the status. A low-confidence selector is persisted as-is so A4
 *   can prioritise re-profiling; the recipe stays 'active' and A4 marks it
 *   'stale' if it fails on execution. (Decision closed by the user.)
 *
 * STATUS = re-derived WITH A FLOOR (not purely re-derived). The verdict is
 *   'failed' if EITHER (a) a structural rule fails, OR (b) the model itself
 *   emitted recipe_status = 'failed'. So 'active' requires the rules to pass AND
 *   the model to NOT have declared failure. The code may DEGRADE active→failed,
 *   but NEVER promotes failed→active: the model's 'failed' is the only SEMANTIC
 *   signal A3 has (HTML that was an error/challenge page, a site that is not a
 *   decants storefront, a placeholder layout) — the structural cut cannot see it,
 *   and overwriting it would discard evidence only the model held. A model-emitted
 *   'stale' is treated as NON-failed (A3 never originates 'stale'; the rules
 *   decide), and 'stale' is never produced here.
 *
 * Side-effect-free and unit-testable without Postgres, OpenAI, or Bright Data.
 * The container's pipeline wraps it and writes `failures` / `llmDeclaredFailed`
 * into run_logs.metadata.
 */

import type {
  FieldSelector,
  RecipeStatus,
  SiteRecipe,
} from './schemas/site-recipe.schema.js'

/** The six selector slots. */
export type SelectorField = keyof SiteRecipe['selectors']

/** The three slots a recipe cannot be 'active' without. */
export const MANDATORY_FIELDS = [
  'title',
  'price',
  'stock',
] as const satisfies readonly SelectorField[]

/** Every slot, in deterministic order — Rule 2 applies to all of them. */
export const SELECTOR_FIELDS = [
  'title',
  'price',
  'stock',
  'currency',
  'ml',
  'sku',
] as const satisfies readonly SelectorField[]

/** Why a STRUCTURAL rule forced a slot to fail. One entry per offending slot. */
export type ProfileFailureReason =
  | 'mandatory_selector_missing' // Rule 1: a title/price/stock selector is absent or empty.
  | 'attribute_name_missing' //     Rule 2: a source='attribute' selector has no attribute_name.

export interface ProfileFailure {
  readonly field: SelectorField
  readonly reason: ProfileFailureReason
}

export interface ValidateAndProfileResult {
  /** The input recipe with recipe_status set to the resolved verdict (floor applied). */
  readonly recipe: SiteRecipe
  /** Resolved status: 'active' iff `failures` is empty AND the model did not declare failure. */
  readonly status: RecipeStatus
  /** Per-slot STRUCTURAL failures (Rules 1 & 2). Can be empty even when status is 'failed'. */
  readonly failures: ReadonlyArray<ProfileFailure>
  /** The semantic floor: true iff the model itself emitted recipe_status === 'failed'. */
  readonly llmDeclaredFailed: boolean
}

/** A selector is usable when it exists and carries a non-empty `selector`. */
function isUsableSelector(
  sel: FieldSelector | null | undefined,
): sel is FieldSelector {
  return sel != null && typeof sel.selector === 'string' && sel.selector.trim().length > 0
}

/** Rule 2 predicate: a selector reading an attribute needs a non-empty name. */
function attributeNameMissing(sel: FieldSelector): boolean {
  return (
    sel.source === 'attribute' &&
    (sel.attribute_name == null || sel.attribute_name.trim().length === 0)
  )
}

/**
 * Resolve a recipe's recipe_status from the two cross-field rules plus the
 * model's own 'failed' floor, and return it alongside the per-slot structural
 * failures and the floor flag (both for run_logs.metadata).
 */
export function validateAndProfile(recipe: SiteRecipe): ValidateAndProfileResult {
  const failures: ProfileFailure[] = []

  // Rule 1 — every mandatory slot must be a usable selector.
  for (const field of MANDATORY_FIELDS) {
    if (!isUsableSelector(recipe.selectors[field])) {
      failures.push({ field, reason: 'mandatory_selector_missing' })
    }
  }

  // Rule 2 — any PRESENT selector with source='attribute' needs attribute_name
  // (all six slots; a null optional slot is skipped).
  for (const field of SELECTOR_FIELDS) {
    const sel = recipe.selectors[field]
    if (sel != null && attributeNameMissing(sel)) {
      failures.push({ field, reason: 'attribute_name_missing' })
    }
  }

  // The model's 'failed' is a floor the code can never lift. 'stale' (which A3
  // never originates) is treated as non-failed — the rules decide.
  const llmDeclaredFailed = recipe.recipe_status === 'failed'

  const status: RecipeStatus =
    failures.length === 0 && !llmDeclaredFailed ? 'active' : 'failed'

  return {
    recipe: { ...recipe, recipe_status: status },
    status,
    failures,
    llmDeclaredFailed,
  }
}
