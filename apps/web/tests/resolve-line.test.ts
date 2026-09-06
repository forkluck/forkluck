import { describe, expect, it, vi } from "vitest"

import { resolveLine, withPreparationNote } from "@/lib/recipe/resolve-line"

const EGG = { id: "pantry-egg", name: "Egg", preparations: ["large", "medium"] }
const CURD = { id: "rec-curd", publicId: "rcp_curd", title: "Lemon Curd" }

function sources(
  overrides: Partial<Parameters<typeof resolveLine>[1]> = {}
): Parameters<typeof resolveLine>[1] {
  return {
    ingredients: [EGG],
    recipes: [CURD],
    searchCatalog: vi.fn().mockResolvedValue({ items: [] }),
    activateCatalog: vi.fn().mockResolvedValue({ error: "no" }),
    ...overrides,
  }
}

describe("resolveLine", () => {
  it("links a plural to the pantry row that stocks it", async () => {
    const resolved = await resolveLine(
      { baseName: "eggs" },
      sources({ ingredients: [{ id: "pantry-egg", name: "Egg" }] })
    )
    expect(resolved?.patch).toEqual({
      kind: "ingredient",
      ingredientId: "pantry-egg",
      subrecipeId: null,
      subrecipePublicId: null,
      displayName: "Egg",
      preparationNote: "",
    })
  })

  it("leaves an archived pantry row for the catalog to answer", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({ items: [] })
    const resolved = await resolveLine(
      { baseName: "eggs" },
      sources({
        ingredients: [
          { id: "pantry-egg", name: "Egg", status: "archived" as const },
        ],
        searchCatalog,
      })
    )
    expect(resolved).toBeNull()
    expect(searchCatalog).toHaveBeenCalled()
  })

  it("reads a size word as the preparation it names", async () => {
    const resolved = await resolveLine(
      {
        baseName: "large eggs",
        identityCandidates: ["egg"],
        sizeWord: "large",
      },
      sources()
    )
    expect(resolved?.patch.ingredientId).toBe("pantry-egg")
    expect(resolved?.patch.preparationNote).toBe("large")
  })

  it("keeps the note the line already carried, preparation first", async () => {
    const resolved = await resolveLine(
      {
        baseName: "large eggs",
        noteText: "2 ounces; 56 g",
        identityCandidates: ["egg"],
        sizeWord: "large",
      },
      sources()
    )
    expect(resolved?.patch.preparationNote).toBe("large, 2 ounces; 56 g")
  })

  it("falls back to the qualifier when the line has no written note", async () => {
    const resolved = await resolveLine(
      { baseName: "eggs", qualifier: "beaten" },
      sources({ ingredients: [{ id: "pantry-egg", name: "Egg" }] })
    )
    expect(resolved?.patch.preparationNote).toBe("beaten")
  })

  it("links a title the cook already has as a recipe", async () => {
    const resolved = await resolveLine({ baseName: "lemon curd" }, sources())
    expect(resolved?.patch).toEqual({
      kind: "subrecipe",
      ingredientId: null,
      subrecipeId: "rec-curd",
      subrecipePublicId: "rcp_curd",
      displayName: "Lemon Curd",
      preparationNote: "",
    })
  })

  it("prefers the pantry over a recipe of the same name", async () => {
    const resolved = await resolveLine(
      { baseName: "Lemon Curd" },
      sources({ ingredients: [{ id: "pantry-curd", name: "Lemon curd" }] })
    )
    expect(resolved?.patch.ingredientId).toBe("pantry-curd")
  })

  it("pulls an exact catalog match into the pantry", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [
        { id: "cat-other", name: "Lemon zest" },
        { id: "cat-juice", name: "Lemon juice", preparations: [] },
      ],
    })
    const activateCatalog = vi.fn().mockResolvedValue({
      id: "pantry-juice",
      name: "Lemon juice",
      preparations: [],
    })
    const resolved = await resolveLine(
      { baseName: "lemon juice" },
      sources({ searchCatalog, activateCatalog })
    )
    expect(searchCatalog).toHaveBeenCalledWith("lemon juice")
    expect(activateCatalog).toHaveBeenCalledWith("cat-juice")
    expect(resolved?.patch.ingredientId).toBe("pantry-juice")
    expect(resolved?.activated).toEqual({
      id: "pantry-juice",
      name: "Lemon juice",
      preparations: [],
    })
  })

  it("treats the plural of the complete name as the same identity", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [{ id: "cat-tomato", name: "San Marzano tomato" }],
    })
    const activateCatalog = vi.fn().mockResolvedValue({
      id: "pantry-tomato",
      name: "San Marzano tomato",
      preparations: [],
    })

    const resolved = await resolveLine(
      { baseName: "San Marzano tomatoes" },
      sources({ searchCatalog, activateCatalog })
    )

    expect(activateCatalog).toHaveBeenCalledWith("cat-tomato")
    expect(resolved?.patch.ingredientId).toBe("pantry-tomato")
  })

  it("links a synonym the catalog card answers to", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [
        { id: "cat-caster", name: "Caster sugar", aliases: [] },
        {
          id: "cat-powdered",
          name: "Powdered sugar",
          preparations: [],
          aliases: ["confectioners sugar", "icing sugar"],
        },
      ],
    })
    const activateCatalog = vi.fn().mockResolvedValue({
      id: "pantry-powdered",
      name: "Powdered sugar",
      preparations: [],
    })
    const resolved = await resolveLine(
      { baseName: "confectioners sugar" },
      sources({ searchCatalog, activateCatalog })
    )
    expect(activateCatalog).toHaveBeenCalledWith("cat-powdered")
    expect(resolved?.patch.ingredientId).toBe("pantry-powdered")
    expect(resolved?.patch.displayName).toBe("Powdered sugar")
  })

  it("does not replace a specific ingredient through a generic alias", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [
        {
          id: "cat-sirloin",
          name: "Sirloin steak",
          aliases: ["sirloin"],
        },
      ],
    })
    const activateCatalog = vi.fn().mockResolvedValue({
      id: "pantry-sirloin",
      name: "Sirloin steak",
      preparations: [],
    })

    const resolved = await resolveLine(
      {
        baseName: "lamb sirloin",
        identityCandidates: ["lamb sirloin", "sirloin"],
      },
      sources({ searchCatalog, activateCatalog })
    )

    expect(resolved).toBeNull()
    expect(activateCatalog).not.toHaveBeenCalled()
  })

  it.each([
    ["Blood orange juice", "Orange juice"],
    ["Graffiti eggplant", "Eggplant"],
    ["San Marzano tomatoes", "Tomatoes"],
    ["Diamond Crystal kosher salt", "Kosher salt"],
  ])("does not remove words from %s to reach %s", async (written, generic) => {
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [{ id: "cat-generic", name: generic, aliases: [] }],
    })
    const activateCatalog = vi.fn().mockResolvedValue({
      id: "pantry-generic",
      name: generic,
      preparations: [],
    })

    const resolved = await resolveLine(
      {
        baseName: written,
        identityCandidates: [written, generic],
      },
      sources({ ingredients: [], searchCatalog, activateCatalog })
    )

    expect(resolved).toBeNull()
    expect(searchCatalog).toHaveBeenCalledTimes(1)
    expect(searchCatalog).toHaveBeenCalledWith(written)
    expect(activateCatalog).not.toHaveBeenCalled()
  })

  it("prefers the card named as written over one aliased to it", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [
        { id: "cat-alias", name: "Powdered sugar", aliases: ["icing sugar"] },
        { id: "cat-name", name: "Icing sugar", aliases: [] },
      ],
    })
    const activateCatalog = vi.fn().mockResolvedValue({
      id: "pantry-icing",
      name: "Icing sugar",
      preparations: [],
    })
    await resolveLine(
      { baseName: "icing sugar" },
      sources({ searchCatalog, activateCatalog })
    )
    expect(activateCatalog).toHaveBeenCalledWith("cat-name")
  })

  it("still needs a pick for a fuzzy hit no synonym covers", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({
      items: [
        {
          id: "cat-powdered",
          name: "Powdered sugar",
          aliases: ["confectioners sugar"],
        },
      ],
    })
    const activateCatalog = vi.fn().mockResolvedValue({ error: "no" })
    expect(
      await resolveLine(
        { baseName: "powdened sugra" },
        sources({ searchCatalog, activateCatalog })
      )
    ).toBeNull()
    expect(activateCatalog).not.toHaveBeenCalled()
  })

  it("leaves a name nothing answers unlinked", async () => {
    const searchCatalog = vi
      .fn()
      .mockResolvedValue({ items: [{ id: "cat-1", name: "Carrots" }] })
    expect(
      await resolveLine({ baseName: "popo" }, sources({ searchCatalog }))
    ).toBeNull()
  })

  it("stays unlinked when the catalog copy fails", async () => {
    const searchCatalog = vi
      .fn()
      .mockResolvedValue({ items: [{ id: "cat-1", name: "Popo" }] })
    const activateCatalog = vi.fn().mockResolvedValue({ error: "no" })
    expect(
      await resolveLine(
        { baseName: "popo" },
        sources({ searchCatalog, activateCatalog })
      )
    ).toBeNull()
  })

  it("never asks the catalog for a name the pantry answered", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({ items: [] })
    await resolveLine({ baseName: "egg" }, sources({ searchCatalog }))
    expect(searchCatalog).not.toHaveBeenCalled()
  })
})

describe("withPreparationNote", () => {
  it("puts the preparation in front of what is already written", () => {
    expect(withPreparationNote("2 ounces; 56 g", "large")).toBe(
      "large, 2 ounces; 56 g"
    )
  })

  it("keeps the note untouched when there is no preparation", () => {
    expect(withPreparationNote("softened", null)).toBe("softened")
  })

  it("does not repeat a preparation the note already names", () => {
    expect(withPreparationNote("Diced, 2 cm", "diced")).toBe("Diced, 2 cm")
  })
})

describe("resolveLine keeps complete ingredient identities", () => {
  const sources = () => ({
    ingredients: [{ id: "pantry-salt", name: "Kosher salt" }],
    recipes: [],
    searchCatalog: vi.fn(async () => ({ items: [] })),
    activateCatalog: vi.fn(async () => ({ error: "unused" })),
  })

  it("does not infer a pantry row by removing a presumed brand", async () => {
    const resolved = await resolveLine(
      {
        baseName: "Diamond Crystal kosher salt",
        identityCandidates: [
          "diamond crystal kosher salt",
          "kosher salt",
          "salt",
        ],
      },
      sources()
    )
    expect(resolved).toBeNull()
  })

  it("does not search the catalog again with a shortened name", async () => {
    const searchCatalog = vi.fn(async (query: string) => ({
      items:
        query === "kosher salt"
          ? [{ id: "cat-salt", name: "Kosher salt" }]
          : [],
    }))
    const activateCatalog = vi.fn(async () => ({
      id: "pantry-new",
      name: "Kosher salt",
      preparations: [],
    }))
    const resolved = await resolveLine(
      {
        baseName: "Diamond Crystal kosher salt",
        identityCandidates: [
          "diamond crystal kosher salt",
          "kosher salt",
          "salt",
        ],
      },
      { ingredients: [], recipes: [], searchCatalog, activateCatalog }
    )
    expect(searchCatalog).toHaveBeenCalledTimes(1)
    expect(searchCatalog).toHaveBeenCalledWith("Diamond Crystal kosher salt")
    expect(activateCatalog).not.toHaveBeenCalled()
    expect(resolved).toBeNull()
  })

  it("matches the size word to a preparation under the bare name", async () => {
    const resolved = await resolveLine(
      {
        baseName: "large eggs",
        identityCandidates: ["egg"],
        sizeWord: "large",
      },
      {
        ...sources(),
        ingredients: [
          { id: "pantry-egg", name: "Egg", preparations: ["large"] },
        ],
      }
    )
    expect(resolved?.patch.ingredientId).toBe("pantry-egg")
    expect(resolved?.patch.preparationNote).toBe("large")
  })
})

describe("resolveLine prefers the specific over the generic", () => {
  it("takes an exact catalog card over a generic pantry row", async () => {
    const searchCatalog = vi.fn(async () => ({
      items: [
        {
          id: "cat-diamond",
          name: "Diamond Crystal kosher salt",
        },
      ],
    }))
    const activateCatalog = vi.fn(async () => ({
      id: "pantry-diamond",
      name: "Diamond Crystal kosher salt",
      preparations: [],
    }))
    const resolved = await resolveLine(
      {
        baseName: "Diamond Crystal kosher salt",
        identityCandidates: [
          "diamond crystal kosher salt",
          "kosher salt",
          "salt",
        ],
      },
      {
        ingredients: [{ id: "pantry-salt", name: "Salt" }],
        recipes: [],
        searchCatalog,
        activateCatalog,
      }
    )
    expect(resolved?.patch.ingredientId).toBe("pantry-diamond")
    expect(searchCatalog).toHaveBeenCalledTimes(1)
  })

  it("leaves the line open when only a generic pantry row exists", async () => {
    const resolved = await resolveLine(
      {
        baseName: "Diamond Crystal kosher salt",
        identityCandidates: [
          "diamond crystal kosher salt",
          "kosher salt",
          "salt",
        ],
      },
      {
        ingredients: [{ id: "pantry-salt", name: "Salt" }],
        recipes: [],
        searchCatalog: vi.fn(async () => ({ items: [] })),
        activateCatalog: vi.fn(async () => ({ error: "unused" })),
      }
    )
    expect(resolved).toBeNull()
  })

  it("keeps the size word as the note when no preparation carries it", async () => {
    const resolved = await resolveLine(
      {
        baseName: "large eggs",
        identityCandidates: ["egg"],
        sizeWord: "large",
      },
      {
        ingredients: [{ id: "pantry-egg", name: "Egg" }],
        recipes: [],
        searchCatalog: vi.fn(async () => ({ items: [] })),
        activateCatalog: vi.fn(async () => ({ error: "unused" })),
      }
    )
    expect(resolved?.patch.ingredientId).toBe("pantry-egg")
    expect(resolved?.patch.preparationNote).toBe("large")
  })
})

describe("a generic name against the pantry", () => {
  it("does not infer a longer pantry identity from a generic name", async () => {
    const searchCatalog = vi.fn().mockResolvedValue({ items: [] })
    const resolved = await resolveLine(
      { baseName: "sugar" },
      sources({
        ingredients: [{ id: "pantry-granulated", name: "Granulated sugar" }],
        recipes: [],
        searchCatalog,
      })
    )
    expect(resolved).toBeNull()
    expect(searchCatalog).toHaveBeenCalledWith("sugar")
  })

  it("leaves the line unlinked when two pantry rows could be meant", async () => {
    const resolved = await resolveLine(
      { baseName: "sugar" },
      sources({
        ingredients: [
          { id: "pantry-granulated", name: "Granulated sugar" },
          { id: "pantry-brown", name: "Brown sugar" },
        ],
        recipes: [],
      })
    )
    expect(resolved).toBeNull()
  })

  it("does not link salt to the only specific salt the cook stocks", async () => {
    const resolved = await resolveLine(
      { baseName: "salt" },
      sources({
        ingredients: [
          { id: "pantry-kosher", name: "Kosher salt" },
          { id: "pantry-flour", name: "Bread flour" },
        ],
        recipes: [],
      })
    )
    expect(resolved).toBeNull()
  })

  it("does not infer an active specific name after skipping an archived one", async () => {
    const resolved = await resolveLine(
      { baseName: "salt" },
      sources({
        ingredients: [
          { id: "pantry-kosher", name: "Kosher salt" },
          { id: "pantry-sea", name: "Sea salt", status: "archived" as const },
        ],
        recipes: [],
      })
    )
    expect(resolved).toBeNull()
  })

  it("never overrides the row the name was written as", async () => {
    const resolved = await resolveLine(
      { baseName: "sugar" },
      sources({
        ingredients: [
          { id: "pantry-granulated", name: "Granulated sugar" },
          { id: "pantry-sugar", name: "Sugar" },
        ],
        recipes: [],
      })
    )
    expect(resolved?.patch.ingredientId).toBe("pantry-sugar")
  })
})
