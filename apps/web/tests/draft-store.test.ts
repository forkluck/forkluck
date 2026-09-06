// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearDraftsForUser,
  draftKey,
  invoiceDraft,
  menuDraft,
  readDraft,
  recipeDraft,
  writeDraft,
} from "@/lib/draft-store"

const SLOT = {
  workspaceId: "ws-1",
  userId: "user-1",
  kind: "recipe" as const,
  id: "rec-1",
}

const DAY = 24 * 60 * 60 * 1000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
  window.localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("what reaches storage", () => {
  it("keeps the allowlisted recipe fields and nothing else", () => {
    const state = {
      title: "Focaccia",
      description: "Slow rise",
      items: [{ displayName: "Flour" }],
      steps: [],
      batchSizes: [],
      equivalency: null,
      tags: ["bread"],
      currentUserId: "user-1",
      sources: { items: [] },
    }
    const key = draftKey(SLOT)
    writeDraft(key, recipeDraft(state))

    expect(Object.keys(readDraft(key)!.payload as object).sort()).toEqual([
      "batchSizes",
      "description",
      "equivalency",
      "items",
      "steps",
      "tags",
      "title",
    ])
  })

  it("keeps the allowlisted menu and invoice fields", () => {
    const menu = {
      name: "Winter",
      periodStart: null,
      periodEnd: null,
      items: [],
      publicId: "mnu_1",
    }
    const invoice = {
      supplierName: "Acme Produce",
      invoiceDate: "2026-01-01",
      dueDate: "2026-01-31",
      invoiceNumber: "7",
      paymentMethod: "cash",
      subtotal: "10",
      tax: "0",
      total: "10",
      notes: "Left at the back door",
      lines: [],
      currencyCode: "USD",
    }

    expect(Object.keys(menuDraft(menu)).sort()).toEqual([
      "items",
      "name",
      "periodEnd",
      "periodStart",
    ])
    expect(Object.keys(invoiceDraft(invoice)).sort()).toEqual([
      "dueDate",
      "invoiceDate",
      "invoiceNumber",
      "lines",
      "notes",
      "paymentMethod",
      "subtotal",
      "supplierName",
      "tax",
      "total",
    ])
  })

  it("gives a record that has never saved a slot of its own", () => {
    expect(draftKey({ ...SLOT, id: "new:9f1c" })).toBe(
      "fl.draft.v1.ws-1.user-1.recipe.new:9f1c"
    )
    expect(draftKey(SLOT)).toBe("fl.draft.v1.ws-1.user-1.recipe.rec-1")
  })
})

describe("how often, how many, how long", () => {
  it("writes at most once every five seconds", () => {
    const key = draftKey(SLOT)
    writeDraft(key, { title: "one" })
    vi.advanceTimersByTime(4999)
    writeDraft(key, { title: "two" })
    expect(readDraft(key)!.payload).toEqual({ title: "one" })

    vi.advanceTimersByTime(1)
    writeDraft(key, { title: "three" })
    expect(readDraft(key)!.payload).toEqual({ title: "three" })
  })

  it("forgets a draft a week old", () => {
    const key = draftKey(SLOT)
    writeDraft(key, { title: "one" })
    vi.advanceTimersByTime(7 * DAY + 1)

    expect(readDraft(key)).toBeNull()
    expect(window.localStorage.getItem(key)).toBeNull()
  })

  it("keeps twenty drafts, dropping the oldest for the twenty-first", () => {
    for (let index = 0; index < 20; index += 1) {
      writeDraft(draftKey({ ...SLOT, id: `rec-${index}` }), { index })
      vi.advanceTimersByTime(1000)
    }
    writeDraft(draftKey({ ...SLOT, id: "rec-20" }), { index: 20 })

    expect(window.localStorage.length).toBe(20)
    expect(readDraft(draftKey({ ...SLOT, id: "rec-0" }))).toBeNull()
    expect(readDraft(draftKey({ ...SLOT, id: "rec-20" }))!.payload).toEqual({
      index: 20,
    })
  })

  it("makes room when the browser says storage is full", () => {
    writeDraft(draftKey({ ...SLOT, id: "rec-old" }), { title: "old" })
    vi.advanceTimersByTime(1000)
    const setItem = vi.spyOn(window.localStorage, "setItem")
    setItem.mockImplementationOnce(() => {
      throw new Error("QuotaExceededError")
    })

    const key = draftKey({ ...SLOT, id: "rec-new" })
    writeDraft(key, { title: "new" })

    expect(readDraft(draftKey({ ...SLOT, id: "rec-old" }))).toBeNull()
    expect(readDraft(key)!.payload).toEqual({ title: "new" })
  })
})

describe("signing out", () => {
  it("takes this user's drafts in every workspace and leaves everyone else's", () => {
    const mine = draftKey(SLOT)
    const shared = draftKey({ ...SLOT, workspaceId: "ws-2" })
    const theirs = draftKey({ ...SLOT, userId: "user-2" })
    writeDraft(mine, { title: "mine" })
    writeDraft(shared, { title: "shared" })
    writeDraft(theirs, { title: "theirs" })

    clearDraftsForUser("user-1")

    expect(window.localStorage.getItem(mine)).toBeNull()
    expect(window.localStorage.getItem(shared)).toBeNull()
    expect(readDraft(theirs)!.payload).toEqual({ title: "theirs" })
  })
})
