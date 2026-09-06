import { describe, expect, it } from "vitest"

import {
  MAX_RANGE_DAYS,
  dateSearchParam,
  monthSearchParam,
  rangeEndSearchParam,
} from "../lib/date-search-param"
import { uuidParam } from "../lib/uuid-param"

/**
 * The cases below are the frontend half of a two-language contract. The Python
 * half asserts the same table in
 * `apps/api/forkluck/test_calendar_params.py`; a value moved from one column to
 * the other has to move in both places or a page starts forwarding something
 * the backend refuses.
 */

describe("dateSearchParam", () => {
  it("keeps a date the backend can read", () => {
    for (const value of [
      "2026-07-01",
      "2026-12-31",
      "2024-02-29", // a real leap day
      "0001-01-01", // the first date datetime.date has
      "9999-12-30",
    ]) {
      expect(dateSearchParam(value)).toBe(value)
    }
  })

  it("drops a well-formed date that is not on the calendar", () => {
    // Every one of these passes /^\d{4}-\d{2}-\d{2}$/. The month and day
    // overflows used to reach toISOString() as an Invalid Date and throw
    // RangeError, taking down whichever screen read the parameter.
    for (const value of [
      "2026-13-45", // month and day both out of range
      "2026-13-01", // month above 12
      "2026-00-10", // month below 1
      "2026-01-32", // day above any month
      "2026-01-00", // day below 1
      "2026-02-29", // February 29 in a non-leap year
      "2026-02-30",
      "2026-04-31", // day above that month
      "2026-11-31",
      "0000-01-01", // datetime.date has no year 0
      "0000-12-31",
      // A window's exclusive end is the day after, which has no year 10000.
      "9999-12-31",
    ]) {
      expect(dateSearchParam(value)).toBeUndefined()
    }
  })

  it("drops anything that is not a plain calendar-date string", () => {
    for (const value of [
      undefined,
      "",
      "2026-7-1", // unpadded
      "26-07-01",
      "2026-07-01T00:00:00Z",
      "20260701",
      "2026-07-01 ",
      "today",
    ]) {
      expect(dateSearchParam(value)).toBeUndefined()
    }
  })

  it("drops a repeated parameter rather than guessing which one was meant", () => {
    expect(dateSearchParam(["2026-07-01"])).toBeUndefined()
    expect(dateSearchParam(["2026-07-01", "2026-07-02"])).toBeUndefined()
    expect(dateSearchParam([])).toBeUndefined()
  })
})

describe("monthSearchParam", () => {
  it("keeps a month the backend can read", () => {
    for (const value of ["2026-01", "2026-07", "2026-12", "9999-12"]) {
      expect(monthSearchParam(value)).toBe(value)
    }
  })

  it("drops a well-formed month that is not on the calendar", () => {
    for (const value of [
      "2026-13",
      "2026-00",
      "2026-99",
      "9999-99",
      "0000-01",
    ]) {
      expect(monthSearchParam(value)).toBeUndefined()
    }
  })

  it("drops anything that is not a plain calendar-month string", () => {
    for (const value of [
      undefined,
      "",
      "2026-7",
      "2026-07-01",
      "202607",
      ["2026-07"],
    ]) {
      expect(monthSearchParam(value)).toBeUndefined()
    }
  })
})

describe("rangeEndSearchParam", () => {
  it("keeps an end date inside a window the backend will read", () => {
    expect(rangeEndSearchParam("2026-07-01", "2026-07-01")).toBe("2026-07-01")
    expect(rangeEndSearchParam("2026-07-01", "2026-07-31")).toBe("2026-07-31")
  })

  it("keeps the longest window the backend allows and drops the next day", () => {
    // The backend refuses a window when (end - start).days > 365.
    expect(rangeEndSearchParam("2026-01-01", "2026-12-31")).toBe("2026-12-31")
    expect(MAX_RANGE_DAYS).toBe(365)
    expect(rangeEndSearchParam("2026-01-01", "2027-01-01")).toBe("2027-01-01")
    expect(rangeEndSearchParam("2026-01-01", "2027-01-02")).toBeUndefined()
    expect(rangeEndSearchParam("2020-01-01", "2026-01-01")).toBeUndefined()
  })

  it("counts the span in whole days across a daylight-saving boundary", () => {
    // Both endpoints are read at UTC midnight, so a local clock change cannot
    // round the span up into the rejected side of the boundary.
    expect(rangeEndSearchParam("2026-03-01", "2027-03-01")).toBe("2027-03-01")
  })

  it("drops an end date that precedes its start", () => {
    expect(rangeEndSearchParam("2026-07-02", "2026-07-01")).toBeUndefined()
  })

  it("drops an end date with no start date to measure from", () => {
    expect(rangeEndSearchParam(undefined, "2026-07-01")).toBeUndefined()
  })

  it("drops an end date that is not on the calendar", () => {
    expect(rangeEndSearchParam("2026-07-01", "2026-13-45")).toBeUndefined()
    expect(rangeEndSearchParam("2026-07-01", "0000-01-01")).toBeUndefined()
    expect(rangeEndSearchParam("2026-07-01", ["2026-07-02"])).toBeUndefined()
  })
})

describe("uuidParam", () => {
  it("keeps an id Django's uuid converter matches", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    expect(uuidParam(id)).toBe(id)
    expect(uuidParam("00000000-0000-0000-0000-000000000000")).toBe(
      "00000000-0000-0000-0000-000000000000"
    )
  })

  it("drops an id that converter would not match", () => {
    for (const value of [
      undefined,
      "",
      "not-a-uuid",
      "123",
      // Django's UUIDConverter regex is lower-case only.
      "3F2504E0-4F89-11D3-9A0C-0305E82C3301",
      // A urn/compact form Python's uuid.UUID accepts but the URL cannot carry.
      "3f2504e04f8911d39a0c0305e82c3301",
      "urn:uuid:3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "3f2504e0-4f89-11d3-9a0c-0305e82c3301 ",
      "3f2504e0-4f89-11d3-9a0c-0305e82c33011",
      ["3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    ]) {
      expect(uuidParam(value)).toBeUndefined()
    }
  })
})
