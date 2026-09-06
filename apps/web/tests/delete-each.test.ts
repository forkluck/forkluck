import { describe, expect, it, vi } from "vitest"

import { deleteEach } from "../lib/delete-each"

describe("deleteEach", () => {
  it("returns the first failure and leaves later items for retry", async () => {
    const remove = vi
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ error: "Could not delete invoice" })

    await expect(deleteEach(["a", "b", "c"], remove)).resolves.toEqual({
      error: "Could not delete invoice",
    })
    expect(remove.mock.calls).toEqual([["a"], ["b"]])
  })

  it("reports success after every item is deleted", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true })

    await expect(deleteEach(["a", "b"], remove)).resolves.toEqual({ ok: true })
    expect(remove).toHaveBeenCalledTimes(2)
  })
})
