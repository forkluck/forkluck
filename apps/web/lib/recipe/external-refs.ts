export const EXTERNAL_REF_SYSTEMS = ["square", "shopify"] as const

export type ExternalRefSystem = (typeof EXTERNAL_REF_SYSTEMS)[number]

export const EXTERNAL_REF_KINDS = [
  "item",
  "variation",
  "handle",
  "sku",
] as const

export type ExternalRefKind = (typeof EXTERNAL_REF_KINDS)[number]
