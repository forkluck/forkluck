import type {
  SalesModifierCatalogList,
  SalesModifierCatalogOption,
  SalesModifierCatalogRecord,
} from "@/lib/backend/types"

export const MIXED_MODIFIER_ASSOCIATION = "__mixed__"
export const IGNORE_MODIFIER_ASSOCIATION = "__ignore__"

export type ModifierAssociationGroup = {
  id: string
  name: string
  options: SalesModifierCatalogOption[]
  records: SalesModifierCatalogRecord[]
  initialSelection: string
  needsNormalization: boolean
  squareRecordCount: number
  usageCount: number
  lastSeenAt: string | null
  ordinal: number
}

/** Deliberately conservative: only visually identical labels are combined. */
export function modifierLogicalKey(name: string) {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

function groupInitialSelection(
  options: SalesModifierCatalogOption[],
  records: SalesModifierCatalogRecord[]
) {
  const values = [
    ...options.map((option) => option.productId ?? ""),
    ...records.map((record) => record.productId ?? ""),
  ]
  const unique = new Set(values)
  if (unique.size <= 1) {
    return {
      initialSelection: values[0] ?? "",
      needsNormalization: false,
    }
  }
  const associated = [...unique].filter(Boolean)
  if (associated.length === 1) {
    return {
      initialSelection: associated[0]!,
      needsNormalization: true,
    }
  }
  return {
    initialSelection: MIXED_MODIFIER_ASSOCIATION,
    needsNormalization: true,
  }
}

function uniqueRecordCount(
  options: SalesModifierCatalogOption[],
  records: SalesModifierCatalogRecord[]
) {
  const ids = new Set<string>()
  for (const option of options) {
    ids.add(option.externalObjectId || `option:${option.id}`)
  }
  for (const record of records) {
    ids.add(record.externalObjectId || `record:${record.matchKey}`)
  }
  return ids.size
}

export function groupModifierAssociations(
  list: Pick<SalesModifierCatalogList, "id" | "options" | "records">
): ModifierAssociationGroup[] {
  const buckets = new Map<
    string,
    {
      name: string
      options: SalesModifierCatalogOption[]
      records: SalesModifierCatalogRecord[]
      ordinal: number
    }
  >()

  for (const option of list.options) {
    const logicalKey =
      modifierLogicalKey(option.name) || option.externalObjectId
    const bucket = buckets.get(logicalKey) ?? {
      name: option.name,
      options: [],
      records: [],
      ordinal: option.ordinal,
    }
    bucket.options.push(option)
    bucket.ordinal = Math.min(bucket.ordinal, option.ordinal)
    buckets.set(logicalKey, bucket)
  }

  for (const record of list.records) {
    const logicalKey =
      modifierLogicalKey(record.name) || record.externalObjectId
    const bucket = buckets.get(logicalKey) ?? {
      name: record.name || "Unnamed modifier",
      options: [],
      records: [],
      ordinal: Number.MAX_SAFE_INTEGER,
    }
    bucket.records.push(record)
    buckets.set(logicalKey, bucket)
  }

  return [...buckets.entries()]
    .map(([logicalKey, bucket]) => {
      const initial = groupInitialSelection(bucket.options, bucket.records)
      const lastSeenAt = bucket.records.reduce<string | null>((latest, row) => {
        if (!row.lastSeenAt) return latest
        return !latest || row.lastSeenAt > latest ? row.lastSeenAt : latest
      }, null)
      return {
        id: `${list.id}:${logicalKey}`,
        name: bucket.name,
        options: bucket.options,
        records: bucket.records,
        ...initial,
        squareRecordCount: uniqueRecordCount(bucket.options, bucket.records),
        usageCount: bucket.records.reduce(
          (total, row) => total + row.usageCount,
          0
        ),
        lastSeenAt,
        ordinal: bucket.ordinal,
      }
    })
    .sort(
      (left, right) =>
        left.ordinal - right.ordinal || left.name.localeCompare(right.name)
    )
}
