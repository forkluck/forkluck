import { z } from "zod"

/**
 * What a package label states per serving, as typed into the custom value
 * request. The seven a label always carries are required; the rest may be
 * blank, and a blank stays unknown rather than reading as zero. Lives here
 * and not beside the action because a "use server" file may export only
 * functions.
 */
const required = z.number().min(0).max(100000)
const optional = z.number().min(0).max(100000).nullable()

export const customNutritionValuesSchema = z.object({
  calories: required,
  fat: required,
  saturatedFat: required,
  sodiumMg: required,
  totalCarbohydrate: required,
  sugars: required,
  protein: required,
  transFat: optional,
  cholesterolMg: optional,
  fiber: optional,
  addedSugars: optional,
  vitaminDMcg: optional,
  calciumMg: optional,
  ironMg: optional,
  potassiumMg: optional,
})

export type CustomNutritionValues = z.input<typeof customNutritionValuesSchema>

export type CustomNutritionValueKey = keyof CustomNutritionValues

export const CUSTOM_NUTRITION_FIELDS: {
  key: CustomNutritionValueKey
  label: string
  unit: string
  required: boolean
}[] = [
  { key: "calories", label: "Calories", unit: "kcal", required: true },
  { key: "fat", label: "Total fat", unit: "g", required: true },
  { key: "saturatedFat", label: "Saturated fat", unit: "g", required: true },
  { key: "transFat", label: "Trans fat", unit: "g", required: false },
  { key: "cholesterolMg", label: "Cholesterol", unit: "mg", required: false },
  { key: "sodiumMg", label: "Sodium", unit: "mg", required: true },
  {
    key: "totalCarbohydrate",
    label: "Total carbohydrate",
    unit: "g",
    required: true,
  },
  { key: "fiber", label: "Dietary fiber", unit: "g", required: false },
  { key: "sugars", label: "Total sugars", unit: "g", required: true },
  { key: "addedSugars", label: "Added sugars", unit: "g", required: false },
  { key: "protein", label: "Protein", unit: "g", required: true },
  { key: "vitaminDMcg", label: "Vitamin D", unit: "mcg", required: false },
  { key: "calciumMg", label: "Calcium", unit: "mg", required: false },
  { key: "ironMg", label: "Iron", unit: "mg", required: false },
  { key: "potassiumMg", label: "Potassium", unit: "mg", required: false },
]

export const submittedCustomNutritionValuesSchema = z.strictObject({
  calories: z.number().nullable(),
  fat: z.number().nullable(),
  saturatedFat: z.number().nullable(),
  transFat: z.number().nullable(),
  cholesterolMg: z.number().nullable(),
  sodiumMg: z.number().nullable(),
  totalCarbohydrate: z.number().nullable(),
  fiber: z.number().nullable(),
  sugars: z.number().nullable(),
  addedSugars: z.number().nullable(),
  protein: z.number().nullable(),
  vitaminDMcg: z.number().nullable(),
  calciumMg: z.number().nullable(),
  ironMg: z.number().nullable(),
  potassiumMg: z.number().nullable(),
})
