import type {
  SalesProductVariantRow,
  SalesIdentityKind,
  SalesModifierReviewItem,
} from "@/lib/backend/types"

export const MAX_QUANTITY_MULTIPLIER = 1_000_000

export function channelLabel(channel: "square" | "shopify") {
  return channel === "square" ? "Square" : "Shopify"
}

/** A rule's scope rather than an identity's channel, so it may be every one. */
export function ruleChannelLabel(channel: "square" | "shopify" | null) {
  return channel === null ? "All channels" : channelLabel(channel)
}

export function identityKindLabel(kind: SalesIdentityKind) {
  return kind === "modifier" ? "Modifier" : "Item"
}

const multiplierFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 3,
})

export function formatMultiplier(value: number) {
  return multiplierFormat.format(value)
}

export type MultiplierResult =
  { ok: true; value: number } | { ok: false; error: string }

/**
 * Mirrors the backend rule: units per sale must be a positive decimal no
 * larger than a million. Zero and negatives are rejected, never coerced.
 */
export function parseMultiplier(raw: string): MultiplierResult {
  const text = raw.trim()
  if (!text) return { ok: false, error: "Enter units per sale." }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return { ok: false, error: "Units per sale has to be a number." }
  }
  if (value <= 0) {
    return { ok: false, error: "Units per sale has to be greater than zero." }
  }
  if (value > MAX_QUANTITY_MULTIPLIER) {
    return { ok: false, error: "Units per sale is too large." }
  }
  return { ok: true, value }
}

export type BundleMember = { productId: string; quantity: number }

/** Mirrors the backend rule: a whole number from 1 to the multiplier ceiling. */
export function parseMemberQuantity(raw: string): MultiplierResult {
  const text = raw.trim()
  if (!text) return { ok: false, error: "Enter units for every product." }
  const value = Number(text)
  if (!Number.isInteger(value)) {
    return { ok: false, error: "Units per product has to be a whole number." }
  }
  if (value < 1) {
    return { ok: false, error: "Units per product has to be at least one." }
  }
  if (value > MAX_QUANTITY_MULTIPLIER) {
    return { ok: false, error: "Units per product is too large." }
  }
  return { ok: true, value }
}

/** Mirrors the backend rule: a whole percent from 0 to 100. */
export function parseAttributionPercent(raw: string): MultiplierResult {
  const text = raw.trim()
  if (!text) return { ok: false, error: "Enter how much of the sale counts." }
  const value = Number(text)
  if (!Number.isInteger(value)) {
    return { ok: false, error: "Attribution has to be a whole percent." }
  }
  if (value < 0 || value > 100) {
    return { ok: false, error: "Attribution has to be between 0 and 100." }
  }
  return { ok: true, value }
}

/** Client-side mirror of the product-component rules a box has to satisfy. */
export function bundleMembersValidationError(members: BundleMember[]) {
  if (members.length < 2 || members.length > 50) {
    return "Choose between 2 and 50 products for this box."
  }
  if (
    new Set(members.map((member) => member.productId)).size !== members.length
  ) {
    return "A box cannot contain the same product twice."
  }
  if (
    members.some(
      (member) =>
        !Number.isInteger(member.quantity) ||
        member.quantity < 1 ||
        member.quantity > MAX_QUANTITY_MULTIPLIER
    )
  ) {
    return "Every product in the box needs whole units."
  }
  return null
}

/** "Square · Item · Burger (Large) · SKU 200120 · ×12" */
export function identityRowSummary(variant: {
  channel: "square" | "shopify"
  identityKind: SalesIdentityKind
  externalName: string
  externalVariantTitle: string
  sku: string
  quantityMultiplier: number
}) {
  const name = [variant.externalName, variant.externalVariantTitle]
    .filter((part) => part.trim())
    .join(" · ")
  return [
    channelLabel(variant.channel),
    identityKindLabel(variant.identityKind),
    name || "Unnamed identity",
    variant.sku ? `SKU ${variant.sku}` : null,
    `×${formatMultiplier(variant.quantityMultiplier)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ")
}

/** Stable client key for one complete provider-scoped external identity. */
export function salesIdentityKey(row: {
  channel: "square" | "shopify"
  providerAccountId: string
  matchKey: string
}) {
  return JSON.stringify([row.channel, row.providerAccountId, row.matchKey])
}

/** Resolve a server suggestion without ever falling back to a loose name/SKU. */
export function suggestedProduct<T extends { id: string }>(
  products: T[],
  suggestedProductId: string | null
) {
  if (!suggestedProductId) return null
  return products.find((product) => product.id === suggestedProductId) ?? null
}

/** Build the exact identity payload persisted by the Catalog dialog. */
export function salesVariantPayload(
  row: {
    id: string | null
    channel: "square" | "shopify"
    providerAccountId: string
    matchKey: string
    identityKind: SalesIdentityKind
    sku: string
    externalName: string
    externalVariantTitle: string
    externalObjectId: string
    productExternalObjectId: string
  },
  quantityMultiplier: number,
  attributionPercent: number | null
) {
  return {
    id: row.id,
    channel: row.channel,
    providerAccountId: row.providerAccountId,
    matchKey: row.matchKey,
    identityKind: row.identityKind,
    sku: row.sku.trim(),
    externalName: row.externalName.trim(),
    externalVariantTitle: row.externalVariantTitle.trim(),
    externalObjectId: row.externalObjectId,
    productExternalObjectId: row.productExternalObjectId,
    quantityMultiplier,
    attributionPercent,
  }
}

/**
 * "Sampler > Chocolate Cookie", with "× 2" appended once the merchant sells
 * the same selection more than once on a line.
 */
export function modifierContextLabel(row: {
  contextLabel: string
  name: string
  quantity: number
}) {
  const base = row.contextLabel || row.name
  return row.quantity > 1
    ? `${base} × ${multiplierFormat.format(row.quantity)}`
    : base
}

/** "3 identities · ×1, ×12" for the menu table's identity column. */
export function identitySummary(variants: SalesProductVariantRow[]) {
  if (!variants.length) return ""
  const multipliers = Array.from(
    new Set(
      variants.map((variant) => formatMultiplier(variant.quantityMultiplier))
    )
  ).sort()
  const noun = variants.length === 1 ? "identity" : "identities"
  const extra =
    multipliers.length === 1 && multipliers[0] === "1"
      ? null
      : multipliers.map((value) => `×${value}`).join(", ")
  return extra
    ? `${variants.length} ${noun} · ${extra}`
    : `${variants.length} ${noun}`
}

export type ConnectedIdentityGroup = {
  key: string
  indexes: number[]
  channels: Array<"square" | "shopify">
  identityKind: SalesIdentityKind
  name: string
  sku: string
}

/** Merge the same SKU across channels without hiding provider-only identities. */
export function connectedIdentityGroups(
  variants: Array<{
    channel: "square" | "shopify"
    identityKind: SalesIdentityKind
    sku: string
    externalName: string
    externalVariantTitle: string
  }>
): ConnectedIdentityGroup[] {
  const groups = new Map<string, ConnectedIdentityGroup>()
  variants.forEach((variant, index) => {
    const normalizedSku = variant.sku.trim().toUpperCase()
    const key = normalizedSku
      ? `sku:${normalizedSku}:${variant.identityKind}`
      : `identity:${index}`
    const existing = groups.get(key)
    if (existing) {
      existing.indexes.push(index)
      if (!existing.channels.includes(variant.channel)) {
        existing.channels.push(variant.channel)
      }
      return
    }
    groups.set(key, {
      key,
      indexes: [index],
      channels: [variant.channel],
      identityKind: variant.identityKind,
      name:
        [variant.externalName, variant.externalVariantTitle]
          .filter((part) => part.trim())
          .join(" · ") || "Unnamed sales item",
      sku: variant.sku.trim(),
    })
  })
  return Array.from(groups.values())
}

/**
 * A canonical-name suggestion is only ever a hint: one candidate can be
 * offered as the default, several must be chosen between explicitly.
 */
export function preselectedCandidateId(
  candidates: Array<{ id: string }>
): string | null {
  return candidates.length === 1 ? candidates[0].id : null
}

/** "12 sales · last seen Mar 3, 2026" under a pending modifier row. */
export function modifierUsageLabel(
  row: Pick<SalesModifierReviewItem, "usageCount" | "lastSeenAt">,
  formatDate: (value: Date) => string
) {
  const noun = row.usageCount === 1 ? "sale" : "sales"
  const seen = row.lastSeenAt
    ? ` · last seen ${formatDate(new Date(row.lastSeenAt))}`
    : ""
  return `${row.usageCount} ${noun}${seen}`
}
