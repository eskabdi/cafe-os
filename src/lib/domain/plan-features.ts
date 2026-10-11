// Plan entitlements (subscription_plans.features, reported to the tenant as session context `plan_features`). These keys are the
// PLATFORM's own feature catalogue (what a subscription plan sells), not a tenant domain: no tenant row, role, station or
// category name is involved. UX only: the server refuses an unentitled command (plan_feature_unavailable|<key>).

/** Features the platform plan editor shows as explicit on/off switches. Unknown keys on a plan are preserved untouched. */
export const PLAN_FEATURES = [
  {
    key: 'installments',
    label: 'Installment vouchers',
    hint: 'Tenants can split an unpaid order into scheduled installments. Without it, existing vouchers can still be collected.',
  },
  {
    key: 'multi_station',
    label: 'Multiple stations',
    hint: 'Tenants can route orders to more than one preparation station.',
  },
] as const

export type PlanFeatureKey = (typeof PLAN_FEATURES)[number]['key']

export const PLAN_FEATURE_KEYS: readonly PlanFeatureKey[] = PLAN_FEATURES.map((f) => f.key)

export function isKnownPlanFeature(key: string): key is PlanFeatureKey {
  return (PLAN_FEATURE_KEYS as readonly string[]).includes(key)
}

/** Anything carrying the session context's `plan_features` (null / absent for platform admins and older payloads). */
export interface PlanFeaturesHolder {
  plan_features?: Readonly<Record<string, unknown>> | null
}

/** Entitled only when the plan's value for `key` is exactly `true`; absent, false, a string or a number are not entitlement. */
export function hasPlanFeature(ctx: PlanFeaturesHolder | null | undefined, key: PlanFeatureKey): boolean {
  const features = ctx?.plan_features
  if (!features || !Object.prototype.hasOwnProperty.call(features, key)) return false
  return features[key] === true
}

/** Fixed explanation shown wherever an installment-voucher entry point is locked by the plan. */
export const INSTALLMENTS_LOCKED_TEXT =
  'Your plan does not include installment vouchers. Existing vouchers can still be collected.'
export const INSTALLMENTS_UPGRADE_HINT = 'To issue new vouchers, ask your administrator to upgrade the plan.'

/** Splits a plan's feature object into the known switches (on only when exactly true) and the untouched unknown keys. */
export function splitPlanFeatures<V>(features: Readonly<Record<string, V>> | null | undefined): {
  switches: Record<PlanFeatureKey, boolean>
  other: Record<string, V>
} {
  const switches = Object.fromEntries(PLAN_FEATURE_KEYS.map((k) => [k, false])) as Record<PlanFeatureKey, boolean>
  const other: Record<string, V> = {}
  for (const [k, v] of Object.entries(features ?? {})) {
    if (isKnownPlanFeature(k)) switches[k] = v === true
    else other[k] = v
  }
  return { switches, other }
}

/** Merges the unknown keys with the switches; every known feature is written explicitly (true or false). */
export function mergePlanFeatures<V>(
  other: Readonly<Record<string, V>>,
  switches: Readonly<Record<PlanFeatureKey, boolean>>,
): Record<string, V | boolean> {
  const out: Record<string, V | boolean> = {}
  for (const [k, v] of Object.entries(other)) if (!isKnownPlanFeature(k)) out[k] = v
  for (const k of PLAN_FEATURE_KEYS) out[k] = switches[k] === true
  return out
}
