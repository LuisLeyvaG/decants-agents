/**
 * validate-and-profile — pure resolution of a Site Profiler (A3) recipe's
 * lifecycle status from the cross-field rules the Zod contract
 * (schemas/site-recipe.schema.ts) documents but deliberately does NOT enforce.
 * The A3 mirror of 02-sourcing-scout/validate-and-filter.ts, adapted to the
 * single-recipe shape with its nested `variants` dimension.
 *
 * A2 partitions a whole-run ENVELOPE ({ providers: [...] }) of many candidates;
 * A3 profiles ONE site and emits ONE recipe (agent.site_recipes is UNIQUE per
 * provider), so there is no array, no per-item loop, and no envelope-level
 * parse_failed abort. The input is the SiteRecipe the model emitted, ALREADY
 * structurally validated by SiteRecipeSchema upstream; this function applies the
 * business rules Zod left open and re-derives recipe_status WITH A FLOOR.
 *
 * RULE 1 — validity (structural): a recipe is 'active' ONLY if `title` AND the
 *   variant dimension's mandatory slots (`variants.container`, `variants.price`,
 *   `variants.availability`) are present with a non-empty `selector`. If any is
 *   missing/degenerate → 'failed'. PURELY structural: A3 cannot verify a selector
 *   truly points at price/stock without executing it — that is A4's job.
 *   SiteRecipeSchema already guarantees presence for Zod-valid input; the check
 *   is kept explicit and defensive, mirroring how A2 re-runs its per-item schema
 *   rather than trusting prior validation. (Replaces the old flat title/price/
 *   stock rule.)
 *
 * RULE 2 — attribute (cross-field): any FieldSelector with source = 'attribute'
 *   MUST carry a non-empty `attribute_name`, else it is unexecutable and the
 *   recipe is 'failed'. Applies to ALL NINE slots (the four product-level +
 *   the five inside `variants`), not just the mandatory ones. Zod allows
 *   attribute_name = null regardless of source on purpose (so the model emits the
 *   honest null for text/json sources), so THIS is a genuine rule Zod left to
 *   code — A3's analogue of A2's non-empty evidence_urls gate.
 *
 * RULE 3 — price_high ↔ mode (cross-field): `variants.price_high` is meaningful
 *   ONLY for mode = 'aggregate-range'. In mode = 'per-offer' it MUST be null
 *   (each Offer has one exact price); a non-null price_high there is an
 *   inconsistent, malformed recipe → 'failed' (reason 'price_high_mode_mismatch').
 *   The INVERSE is deliberately NOT enforced: an 'aggregate-range' recipe that
 *   omits price_high (leaves it null) stays valid — highPrice is a nicety, not a
 *   requirement.
 *
 * NOT a status input: extraction_confidence = 'low' on a mandatory selector does
 *   NOT degrade the status. A low-confidence selector is persisted as-is so A4
 *   can prioritise re-profiling the brittle path; the recipe stays 'active' and
 *   A4 marks it 'stale' if it fails on execution. (Decision closed by the user.)
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

/**
 * A FieldSelector slot, addressed by its dotted path within `selectors`. The
 * four product-level slots are bare keys; the five variant slots are prefixed
 * with `variants.` so reporting is unambiguous across the two levels.
 */
export type SelectorPath =
  | 'title'
  | 'brand'
  | 'sku'
  | 'currency'
  | 'variants.container'
  | 'variants.ml'
  | 'variants.price'
  | 'variants.price_high'
  | 'variants.availability'

/** The slots a recipe cannot be 'active' without (Rule 1). */
export const MANDATORY_FIELDS = [
  'title',
  'variants.container',
  'variants.price',
  'variants.availability',
] as const satisfies readonly SelectorPath[]

/** Every FieldSelector slot, in deterministic order — Rule 2 applies to all. */
export const SELECTOR_FIELDS = [
  'title',
  'brand',
  'sku',
  'currency',
  'variants.container',
  'variants.ml',
  'variants.price',
  'variants.price_high',
  'variants.availability',
] as const satisfies readonly SelectorPath[]

/** Why a rule forced the recipe to fail. One entry per offending slot. */
export type ProfileFailureReason =
  | 'mandatory_selector_missing' // Rule 1: a mandatory selector is absent or empty.
  | 'attribute_name_missing' //     Rule 2: a source='attribute' selector has no attribute_name.
  | 'price_high_mode_mismatch' //   Rule 3: per-offer mode carries a non-null price_high.

export interface ProfileFailure {
  readonly field: SelectorPath
  readonly reason: ProfileFailureReason
}

export interface ValidateAndProfileResult {
  /** The input recipe with recipe_status set to the resolved verdict (floor applied). */
  readonly recipe: SiteRecipe
  /** Resolved status: 'active' iff `failures` is empty AND the model did not declare failure. */
  readonly status: RecipeStatus
  /** Per-slot rule failures (Rules 1, 2 & 3). Can be empty even when status is 'failed'. */
  readonly failures: ReadonlyArray<ProfileFailure>
  /** The semantic floor: true iff the model itself emitted recipe_status === 'failed'. */
  readonly llmDeclaredFailed: boolean
}

/**
 * Resolve a slot path to its FieldSelector, reading DEFENSIVELY so a degenerate
 * (cast) input missing `variants` or a key cannot throw — a missing slot reads
 * as undefined and is handled like a null optional.
 */
function selectorAt(
  recipe: SiteRecipe,
  path: SelectorPath,
): FieldSelector | null | undefined {
  const s = recipe.selectors as Partial<SiteRecipe['selectors']> | undefined
  const v = s?.variants as
    | Partial<SiteRecipe['selectors']['variants']>
    | undefined
  switch (path) {
    case 'title':
      return s?.title
    case 'brand':
      return s?.brand
    case 'sku':
      return s?.sku
    case 'currency':
      return s?.currency
    case 'variants.container':
      return v?.container
    case 'variants.ml':
      return v?.ml
    case 'variants.price':
      return v?.price
    case 'variants.price_high':
      return v?.price_high
    case 'variants.availability':
      return v?.availability
  }
}

/** A selector is usable when it exists and carries a non-empty `selector`. */
function isUsableSelector(
  sel: FieldSelector | null | undefined,
): sel is FieldSelector {
  return (
    sel != null &&
    typeof sel.selector === 'string' &&
    sel.selector.trim().length > 0
  )
}

/** Rule 2 predicate: a selector reading an attribute needs a non-empty name. */
function attributeNameMissing(sel: FieldSelector): boolean {
  return (
    sel.source === 'attribute' &&
    (sel.attribute_name == null || sel.attribute_name.trim().length === 0)
  )
}

/**
 * Resolve a recipe's recipe_status from the three cross-field rules plus the
 * model's own 'failed' floor, and return it alongside the per-slot failures and
 * the floor flag (both for run_logs.metadata).
 */
export function validateAndProfile(recipe: SiteRecipe): ValidateAndProfileResult {
  const failures: ProfileFailure[] = []

  // Rule 1 — every mandatory slot must be a usable selector.
  for (const field of MANDATORY_FIELDS) {
    if (!isUsableSelector(selectorAt(recipe, field))) {
      failures.push({ field, reason: 'mandatory_selector_missing' })
    }
  }

  // Rule 2 — any PRESENT selector with source='attribute' needs attribute_name
  // (all nine slots; a null optional slot is skipped).
  for (const field of SELECTOR_FIELDS) {
    const sel = selectorAt(recipe, field)
    if (sel != null && attributeNameMissing(sel)) {
      failures.push({ field, reason: 'attribute_name_missing' })
    }
  }

  // Rule 3 — price_high is only valid for aggregate-range. A non-null price_high
  // under per-offer mode is an inconsistency → failed. The inverse (aggregate-
  // range without price_high) is allowed and stays active. Read defensively so a
  // degenerate cast missing `variants` cannot throw.
  const variants = recipe.selectors?.variants as
    | Partial<SiteRecipe['selectors']['variants']>
    | undefined
  if (variants?.mode === 'per-offer' && variants.price_high != null) {
    failures.push({
      field: 'variants.price_high',
      reason: 'price_high_mode_mismatch',
    })
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
