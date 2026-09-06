// @vitest-environment jsdom

import * as React from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"

const saveMenu = vi.fn()
const loadMenuProducts = vi.fn()
const saveRecipe = vi.fn()
const saveSalesProduct = vi.fn()
const toastAdd = vi.fn()
const replace = vi.fn()

vi.mock("@/app/(app)/menu/actions", () => ({
  saveMenu: (...args: unknown[]) => saveMenu(...args),
  deleteMenu: vi.fn(),
  loadMenuProducts: (...args: unknown[]) => loadMenuProducts(...args),
}))

vi.mock("@/app/(app)/recipes/actions", () => ({
  saveRecipe: (...args: unknown[]) => saveRecipe(...args),
}))

vi.mock("@/app/(app)/products/actions", () => ({
  saveSalesProduct: (...args: unknown[]) => saveSalesProduct(...args),
}))

vi.mock("next/navigation", () => ({
  usePathname: () => "/menu/new",
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
}))

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}))

import { MenuChrome, useMenuEdit } from "@/components/menus/menu-chrome"
import { MenuEditor } from "@/components/menus/menu-editor"
import {
  NavigationBlockerProvider,
  useNavigationBlocker,
} from "@/components/navigation-blocker"

afterEach(() => {
  cleanup()
  saveMenu.mockReset()
  loadMenuProducts.mockReset()
  saveRecipe.mockReset()
  saveSalesProduct.mockReset()
  toastAdd.mockReset()
  replace.mockReset()
  window.localStorage.clear()
})

const menu = {
  id: "menu-1",
  publicId: "mnu_x",
  editVersion: 3,
  name: "Spring",
  periodStart: null,
  periodEnd: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

const recipe = {
  id: "recipe-1",
  publicId: "rcp_1",
  title: "Bread",
  kind: "recipe",
  category: "Bakery",
  menuPriceCents: 500,
  ingredientCents: 120,
  suffix: "/pc",
}

const latteOption = {
  id: "prod-1",
  publicId: "prd_latte",
  name: "Latte",
  componentProductIds: [],
}

/** The worksheet endpoint's row for the latte, as the picker fetches it. */
const latteRow = {
  id: "prod-1",
  publicId: "prd_latte",
  name: "Latte",
  category: "Drinks",
  sellPriceCents: 450,
  sales: { totalQuantity: 20, attributedNetSalesCents: 9000 },
}

/** A saved recipe row, the way `menu/<ref>/` serves it. */
const savedItem = () => ({
  id: "item-1",
  name: "Bread",
  position: 0,
  sellPriceCents: 500,
  qtySold: 4,
  recipeId: recipe.id,
  recipePublicId: recipe.publicId,
  recipeName: recipe.title,
  productId: null,
  productPublicId: null,
  productName: null,
  category: "Bakery",
  foodCostCents: 120,
  sourceSellPriceCents: 500,
  sourceQtySold: null,
  original: { sellPriceCents: 500, qtySold: 4, foodCostCents: 120 },
})

function newMenuScreen(onAnswer: (allowed: boolean) => void = () => undefined) {
  render(
    <NavigationBlockerProvider>
      <MenuChrome title="New menu">
        <MenuEditor
          initial={null}
          recipes={[]}
          products={[]}
          currencyCode="USD"
          timeZone="UTC"
          currentUserId="user-1"
        />
      </MenuChrome>
      <LeaveButton onAnswer={onAnswer} />
    </NavigationBlockerProvider>
  )
  return screen.getByRole("button", { name: "Save" })
}

/** Whoever wants to leave asks the blocker first, exactly as a link does. */
function LeaveButton({ onAnswer }: { onAnswer: (allowed: boolean) => void }) {
  const { confirmNavigation } = useNavigationBlocker()
  return (
    <button
      type="button"
      onClick={() => void confirmNavigation().then(onAnswer)}
    >
      Leave
    </button>
  )
}

function savedMenuScreen(
  items: ReturnType<typeof savedItem>[] = [savedItem()],
  onAnswer: (allowed: boolean) => void = () => undefined
) {
  render(
    <NavigationBlockerProvider>
      <MenuChrome title="Spring" publicId="mnu_x">
        <MenuEditor
          key={menu.id}
          initial={{
            menu,
            items,
            recipes: [recipe],
            ingredients: [],
            products: [latteOption],
            currencyCode: "USD",
          }}
          recipes={[recipe]}
          products={[latteOption]}
          currencyCode="USD"
          timeZone="UTC"
          currentUserId="user-1"
        />
      </MenuChrome>
      <LeaveButton onAnswer={onAnswer} />
    </NavigationBlockerProvider>
  )
}

/** What the server answers with: the same worksheet, stored. */
const stored = (item = savedItem()) => ({
  menu,
  items: [item],
  recipes: [recipe],
  ingredients: [],
  products: [latteOption],
  currencyCode: "USD",
})

function badge() {
  return screen.getByRole("status").textContent
}

/** Dirties the form the way a cook does: retyping the row's sell price. */
function typePrice(value: string) {
  const price = screen.getByLabelText("Sell price")
  fireEvent.focus(price)
  fireEvent.change(price, { target: { value } })
  fireEvent.blur(price)
}

describe("saving a new menu from the header", () => {
  it("saves on one press of Save", async () => {
    saveMenu.mockResolvedValue(stored())
    const save = newMenuScreen()

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Spring" },
    })
    fireEvent.click(save)
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))

    expect(saveMenu.mock.calls[0][0]).toMatchObject({
      id: null,
      name: "Spring",
    })
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/menu/mnu_x"))
  })

  it("sends each row's link and nothing else", async () => {
    saveMenu.mockResolvedValue(stored())
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))

    const sent = saveMenu.mock.calls[0][0].items[0]
    expect(sent).toEqual({
      id: "item-1",
      name: "Bread",
      recipeId: recipe.id,
      productId: null,
      sellPriceCents: 500,
      qtySold: 4,
      position: 0,
    })
  })

  it("adopts the rows the server stored, so the echo is not a draft", async () => {
    saveMenu.mockResolvedValue(stored({ ...savedItem(), sellPriceCents: 600 }))
    savedMenuScreen()

    typePrice("6.00")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))

    expect(saveMenu.mock.calls[0][0].items[0].sellPriceCents).toBe(600)
    await vi.waitFor(() => expect(badge()).toBe("Saved"))
  })

  it("refuses to save a row with no name and no link", async () => {
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "+ Add" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Name every item" })
      )
    )
    expect(saveMenu).not.toHaveBeenCalled()
  })

  it("sends a named row that links to nothing", async () => {
    saveMenu.mockResolvedValue(stored())
    savedMenuScreen()

    fireEvent.change(screen.getByLabelText("Quick add item"), {
      target: { value: "Daily special" },
    })
    fireEvent.keyDown(screen.getByLabelText("Quick add item"), {
      key: "Enter",
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
    expect(saveMenu.mock.calls[0][0].items[1]).toEqual({
      id: null,
      name: "Daily special",
      recipeId: null,
      productId: null,
      sellPriceCents: 0,
      qtySold: 0,
      position: 1,
    })
  })

  it("says the menu needs a name instead of doing nothing", () => {
    const save = newMenuScreen()

    fireEvent.click(save)

    expect(saveMenu).not.toHaveBeenCalled()
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Give the menu a name" })
    )
  })

  it("has no button inside the form that submits it", () => {
    newMenuScreen()

    const form = screen.getByRole("form", { name: "Menu" })
    const submitters = Array.from(form.querySelectorAll("button")).filter(
      (button) => button.type !== "button"
    )

    expect(submitters.map((button) => button.textContent)).toEqual([])
  })
})

describe("linking a row through the picker", () => {
  it("links a product and takes its period figures onto the row", async () => {
    loadMenuProducts.mockResolvedValue({ items: [latteRow] })
    saveMenu.mockResolvedValue(stored())
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "+ Add" }))
    const field = screen.getByLabelText("Item name")
    fireEvent.change(field, { target: { value: "Latte" } })
    fireEvent.click(screen.getByRole("option", { name: /Latte/ }))

    expect(loadMenuProducts).toHaveBeenCalledWith({
      q: "Latte",
      start: null,
      end: null,
    })
    await screen.findByText("Drinks")

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
    expect(saveMenu.mock.calls[0][0].items[1]).toEqual({
      id: null,
      name: "Latte",
      recipeId: null,
      productId: "prod-1",
      sellPriceCents: 450,
      qtySold: 20,
      position: 1,
    })
  })

  it("creates a recipe when nothing matches and links it", async () => {
    saveRecipe.mockResolvedValue({
      id: "rec-9",
      publicId: "rcp_9",
      code: "R9",
      editVersion: 0,
    })
    saveMenu.mockResolvedValue(stored())
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "+ Add" }))
    const field = screen.getByLabelText("Item name")
    fireEvent.change(field, { target: { value: "Soup of the day" } })
    fireEvent.click(
      screen.getByRole("button", { name: "Add recipe “Soup of the day”" })
    )

    await vi.waitFor(() =>
      expect(saveRecipe).toHaveBeenCalledWith({
        id: null,
        title: "Soup of the day",
      })
    )
    expect(
      await screen.findByRole("link", { name: "Soup of the day" })
    ).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
    expect(saveMenu.mock.calls[0][0].items[1]).toMatchObject({
      recipeId: "rec-9",
      productId: null,
    })
  })
})

describe("resetting the baseline", () => {
  it("saves with rebaseline once the confirm is answered", async () => {
    window.localStorage.setItem("menu.trackVariance", "on")
    saveMenu.mockResolvedValue(stored())
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "Reset baseline" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Reset the baseline?")).toBeTruthy()
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset baseline" })
    )

    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
    expect(saveMenu.mock.calls[0][0].rebaseline).toBe(true)
  })

  it("keeps the rebaseline for the save that follows a validation failure", async () => {
    window.localStorage.setItem("menu.trackVariance", "on")
    saveMenu.mockResolvedValue(stored())
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "+ Add" }))
    fireEvent.click(screen.getByRole("button", { name: "Reset baseline" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset baseline" })
    )
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Name every item" })
      )
    )
    expect(saveMenu).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Actions for row" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
    expect(saveMenu.mock.calls[0][0].rebaseline).toBe(true)
  })

  it("re-sends the rebaseline that rode along with a save already in flight", async () => {
    window.localStorage.setItem("menu.trackVariance", "on")
    const echo = stored()
    let release: (value: unknown) => void = () => undefined
    saveMenu.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    saveMenu.mockResolvedValue(echo)
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Reset baseline" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset baseline" })
    )
    await act(async () => {
      release(echo)
    })

    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(2))
    expect(saveMenu.mock.calls[0][0].rebaseline).toBeUndefined()
    expect(saveMenu.mock.calls[1][0].rebaseline).toBe(true)
  })

  it("is offered only while variance is tracked", () => {
    savedMenuScreen()

    expect(screen.queryByRole("button", { name: "Reset baseline" })).toBeNull()
  })
})

describe("the header's Save button", () => {
  it("calls the save the screen registered", () => {
    const save = vi.fn().mockResolvedValue(undefined)
    function Screen() {
      const { saveRef } = useMenuEdit()
      React.useEffect(() => {
        saveRef.current = save
      })
      return null
    }
    render(
      <MenuChrome title="New menu">
        <Screen />
      </MenuChrome>
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(save).toHaveBeenCalledTimes(1)
  })
})

describe("a save the server would not take", () => {
  it("reads Not saved after a request that failed", async () => {
    saveMenu.mockResolvedValue({ error: "Backend is down" })
    savedMenuScreen()

    typePrice("6.00")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(badge()).toBe("Not saved"))
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Backend is down" })
    )
  })

  it("stops saving and offers a way out when the menu changed elsewhere", async () => {
    saveMenu.mockResolvedValue({
      error: "This menu changed in another window. Reload to see the latest.",
      code: "stale_write",
    })
    savedMenuScreen()

    typePrice("6.00")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await vi.waitFor(() => expect(badge()).toBe("Changed elsewhere"))
    expect(
      screen.getByText(
        "This menu changed in another window. Reload to see the latest."
      )
    ).not.toBeNull()
    expect(screen.getByRole("button", { name: "Reload" })).not.toBeNull()

    // The same stale version is never sent a second time.
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
  })

  it("sends the version it was given, and the one the save answered with", async () => {
    saveMenu.mockResolvedValue({
      ...stored(),
      menu: { ...menu, editVersion: 4 },
    })
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(badge()).toBe("Saved"))
    fireEvent.click(screen.getByRole("button", { name: "Saved" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(2))

    expect(saveMenu.mock.calls[0][0].expectedEditVersion).toBe(3)
    expect(saveMenu.mock.calls[1][0].expectedEditVersion).toBe(4)
  })
})

describe("a menu edited while its save is in flight", () => {
  it("keeps what the cook typed rather than the rows the server sent back", async () => {
    let finish: ((detail: unknown) => void) | null = null
    saveMenu.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    savedMenuScreen()

    typePrice("6.00")
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(saveMenu).toHaveBeenCalledTimes(1))
    typePrice("7.00")

    await act(async () => {
      finish?.(stored({ ...savedItem(), sellPriceCents: 600 }))
    })

    expect(
      (screen.getByLabelText("Sell price") as HTMLInputElement).value
    ).toBe("7.00")
    await vi.waitFor(() => expect(badge()).toBe("Draft"))
  })
})

describe("leaving a dirty menu", () => {
  it("leaves the route to the exit the cook picked on a create", async () => {
    saveMenu.mockResolvedValue(stored())
    const answers: boolean[] = []
    newMenuScreen((allowed) => answers.push(allowed))

    fireEvent.change(screen.getByLabelText("Name (required)"), {
      target: { value: "Spring" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))

    await vi.waitFor(() => expect(answers).toEqual([true]))
    expect(saveMenu).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
    // The entry being left points at the menu that now exists, not /menu/new.
    expect(window.location.pathname).toBe("/menu/mnu_x")
  })

  it("saves on the way out and asks nothing", async () => {
    saveMenu.mockResolvedValue(stored({ ...savedItem(), sellPriceCents: 600 }))
    const answers: boolean[] = []
    savedMenuScreen([savedItem()], (allowed) => answers.push(allowed))

    typePrice("6.00")
    fireEvent.click(screen.getByRole("button", { name: "Leave" }))

    await vi.waitFor(() => expect(answers).toEqual([true]))
    expect(saveMenu).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("changes this device kept", () => {
  const KEY = "fl.draft.v1.user-1.user-1.menu.menu-1"

  it("offers to put back a draft the server never got", async () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        payload: {
          name: "Spring tasting",
          periodStart: null,
          periodEnd: null,
          items: [],
        },
        savedAt: Date.now(),
      })
    )
    savedMenuScreen()

    fireEvent.click(screen.getByRole("button", { name: "Restore" }))

    await vi.waitFor(() =>
      expect(
        (screen.getByLabelText("Name (required)") as HTMLInputElement).value
      ).toBe("Spring tasting")
    )
    expect(badge()).toBe("Draft")
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull()
  })

  it("keeps a copy while dirty and drops it once the save lands", async () => {
    saveMenu.mockResolvedValue(stored({ ...savedItem(), sellPriceCents: 600 }))
    savedMenuScreen()

    typePrice("6.00")
    await vi.waitFor(() =>
      expect(window.localStorage.getItem(KEY)).not.toBeNull()
    )

    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    await vi.waitFor(() => expect(window.localStorage.getItem(KEY)).toBeNull())
  })
})
