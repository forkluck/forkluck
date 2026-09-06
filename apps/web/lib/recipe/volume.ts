import vocabulary from "../../../../data/parser-vocabulary.json"

/** Millilitres in one of each volume unit, from the shared unit catalog. */
export const MILLILITERS_PER_UNIT: Record<string, number> = Object.fromEntries(
  vocabulary.units
    .filter((unit) => unit.family === "volume" && unit.perBase !== null)
    .map((unit) => [unit.slug, unit.perBase as number])
)
