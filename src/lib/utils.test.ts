import {describe, expect, it} from "vitest"

import {asArray, asRecord, asTrimmedText, capitalize, clamp, fnv1a64Checksum, formatCount, isRecord, relativeAge} from "./utils"

// The structure string and checksum from a real Tapoo export (v2.5.1, 6x4), carried here rather than
// imported from the maze suite: this describes the hash, not the maze. maze.test.ts keeps the whole
// REAL_MAZE block for the decoder tests that need the rest of it.
const REAL_STRUCTURE =
  "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210"
const REAL_CHECKSUM = "0x74af82cb14470b9d"

describe("fnv1a64Checksum", () => {
  it("reproduces the checksum Tapoo stamped on a real maze", () => {
    expect(fnv1a64Checksum(REAL_STRUCTURE)).toBe(REAL_CHECKSUM)
  })

  it("changes when the structure changes", () => {
    expect(fnv1a64Checksum(`${REAL_STRUCTURE}0`)).not.toBe(REAL_CHECKSUM)
  })
})

// An array is an object to `typeof`, and that is the whole reason these two exist in the shape they do.
// log-contract carried a looser copy that reported a list as a record, handing the caller something
// whose named fields were all undefined - "present but empty" when the truth was "wrong kind of thing".
describe("isRecord", () => {
  it("accepts a plain object", () => {
    expect(isRecord({a: 1})).toBe(true)
    expect(isRecord({})).toBe(true)
  })

  it("rejects an array, which typeof calls an object", () => {
    expect(isRecord([])).toBe(false)
    expect(isRecord([1, 2])).toBe(false)
  })

  it("rejects null and the primitives", () => {
    for (const value of [null, undefined, 0, "", "text", true]) {
      expect(isRecord(value)).toBe(false)
    }
  })
})

describe("asRecord", () => {
  it("passes a record through unchanged, by identity", () => {
    const value = {a: 1}
    expect(asRecord(value)).toBe(value)
  })

  it("reads an array as an empty record rather than as a list of fields", () => {
    expect(asRecord([1, 2])).toEqual({})
  })

  it("reads anything else as an empty record", () => {
    for (const value of [null, undefined, 0, "text", true]) {
      expect(asRecord(value)).toEqual({})
    }
  })
})

describe("asArray", () => {
  it("passes a list through unchanged, by identity", () => {
    const value = [1, 2]
    expect(asArray(value)).toBe(value)
  })

  it("reads a non-list as empty, so a caller can always iterate", () => {
    for (const value of [null, undefined, {}, "text", 0]) {
      expect(asArray(value)).toEqual([])
    }
  })
})

describe("asTrimmedText", () => {
  it("keeps the text forms that are unambiguous", () => {
    expect(asTrimmedText("  https://example.com/a.json  ")).toBe("https://example.com/a.json")
    expect(asTrimmedText(42)).toBe("42")
    expect(asTrimmedText(false)).toBe("false")
  })

  // String({}) is "[object Object]" - fifteen characters that pass every emptiness check downstream.
  it("reads a composite as absent, not as its default stringification", () => {
    for (const value of [{}, [1, 2], null, undefined]) {
      expect(asTrimmedText(value)).toBe("")
    }
  })
})

describe("capitalize", () => {
  it("raises the first character only", () => {
    expect(capitalize("oscillating")).toBe("Oscillating")
  })

  // The tail is left exactly as it was: a title-caser would mangle a value that already carries a
  // capital of its own, and the callers pass words whose remainder is already right.
  it("leaves the rest of the string alone", () => {
    expect(capitalize("openMoves")).toBe("OpenMoves")
    expect(capitalize("Already")).toBe("Already")
  })

  it("survives an empty string", () => {
    expect(capitalize("")).toBe("")
  })
})

describe("clamp", () => {
  it("returns a value already inside the range", () => {
    expect(clamp(3, 0, 10)).toBe(3)
  })

  it("bounds a value at each end", () => {
    expect(clamp(-4, 0, 10)).toBe(0)
    expect(clamp(99, 0, 10)).toBe(10)
  })

  // Both callers bound an index into a list, and an empty list makes min and max meet.
  it("returns the bound when the range is a single point", () => {
    expect(clamp(5, 0, 0)).toBe(0)
    expect(clamp(-5, 0, 0)).toBe(0)
  })
})

describe("relativeAge", () => {
  const at = (iso: string) => new Date(iso)
  const now = at("2026-09-06T12:00:00Z")

  it("counts in the largest unit that still reads as a whole number", () => {
    expect(relativeAge(at("2026-09-06T11:59:58Z"), now)).toBe("2 seconds ago")
    expect(relativeAge(at("2026-09-06T11:45:00Z"), now)).toBe("15 minutes ago")
    expect(relativeAge(at("2026-09-06T09:00:00Z"), now)).toBe("3 hours ago")
    expect(relativeAge(at("2026-09-01T12:00:00Z"), now)).toBe("5 days ago")
    expect(relativeAge(at("2026-06-06T12:00:00Z"), now)).toBe("3 months ago")
    expect(relativeAge(at("2024-09-06T12:00:00Z"), now)).toBe("2 years ago")
  })

  // "always", not "auto": a freshly built page would otherwise read "now", which is the one answer that
  // stops being true the moment it is read.
  it("says how many seconds rather than 'now'", () => {
    expect(relativeAge(at("2026-09-06T11:59:59Z"), now)).toBe("1 second ago")
  })
})

describe("formatCount", () => {
  it("separates thousands", () => {
    expect(formatCount(1234)).toBe("1,234")
    expect(formatCount(1234567)).toBe("1,234,567")
  })

  it("leaves a small number alone", () => {
    expect(formatCount(0)).toBe("0")
    expect(formatCount(464)).toBe("464")
  })

  it("reads a numeric string, which is how several log fields arrive", () => {
    expect(formatCount("1234")).toBe("1,234")
  })
})
