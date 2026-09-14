import {describe, expect, it} from "vitest"

import {asArray, asRecord, asTrimmedText, capitalize, checksumEntries, clamp, createFnv1a64, fnv1a64Checksum, formatCount, isRecord, relativeAge} from "./utils"

// The structure string and checksum from a real Tapoo export (v2.5.1, 6x4), carried here rather than
// imported from the maze suite: this describes the hash, not the maze. maze.test.ts keeps the whole
// REAL_MAZE block for the decoder tests that need the rest of it.
const REAL_STRUCTURE =
  "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210"
const REAL_CHECKSUM = "0x74af82cb14470b9d"

/** The implementation this replaced, kept as the check on the one that replaced it.
 *
 * A BigInt per byte is the clearest statement of FNV-1a and too slow to ship - 17ms against 5ms on a
 * megabyte - so the limb arithmetic answers for it in production and it answers for the limbs here. Two
 * implementations that were written from the specification rather than from each other, which is what makes
 * one an oracle for the other. */
const referenceFnv1a64 = (text: string): string => {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `0x${hash.toString(16).padStart(16, "0")}`
}

describe("the hash against a byte-at-a-time reference", () => {
  it.each([
    ["empty", ""],
    ["ascii", "tapoo-v2.6.1-agent-api-logs"],
    ["a curly quote, an em dash and an arrow", "\u2019 \u2014 \u2192"],
    ["a surrogate pair", "\u{1d11e}"],
  ])("answers what the reference answers for %s", (_what, text) => {
    expect(fnv1a64Checksum(text)).toBe(referenceFnv1a64(text))
  })

  // Past the encoder buffer's first size, and multi-byte throughout: a buffer sized for one byte per UTF-16
  // unit truncates the encoding here, and both of this module's forms would truncate identically, so only
  // an outside implementation can say the bytes hashed were the text's own.
  it("answers what the reference answers past the buffer's first size", () => {
    const long = "\u00e9\u2014\u2192\u{1d11e} ".repeat(20000)

    expect(long.length).toBeGreaterThan(1 << 16)
    expect(fnv1a64Checksum(long)).toBe(referenceFnv1a64(long))
  })
})

// Taking the hash a piece at a time has to answer what hashing the whole string answers, or the checksum
// a log states and the checksum this recomputes are two different measurements wearing one name.
describe("the incremental form of the same hash", () => {
  it("answers what one update over the joined text answers", () => {
    const pieces = ["{\"a\":1}", ",", "{\"b\":[2,3]}", ",", "\u00e9\u2014\u2192"]
    const hash = createFnv1a64()
    for (const piece of pieces) hash.update(piece)

    expect(hash.digest()).toBe(fnv1a64Checksum(pieces.join("")))
  })

  // Boundaries are the only way the two can part company: each piece is UTF-8 encoded on its own, so a
  // split surrogate pair would encode as two replacement characters. JSON never hands one over split,
  // and this pins that a pair kept whole hashes the same either way.
  it("keeps a surrogate pair whole across pieces", () => {
    const hash = createFnv1a64()
    hash.update("prefix \u{1d11e}")
    hash.update(" suffix")

    expect(hash.digest()).toBe(fnv1a64Checksum("prefix \u{1d11e} suffix"))
  })

  // The producer's contract, stated as an equality: the entries' checksum is the hash of their compact
  // JSON, whichever way it was reached. An implementation that drifted from this would refuse every log.
  it("hashes an array exactly as its compact JSON hashes", () => {
    const entries = [{epochMs: 1, payload: "Agent level started."}, {epochMs: 2, details: {moves: ["MoveDown"]}}]

    expect(checksumEntries(entries)).toBe(fnv1a64Checksum(JSON.stringify(entries)))
    expect(checksumEntries([])).toBe(fnv1a64Checksum("[]"))
  })

  // The one shape where writing each element's JSON in turn is not obviously the same as stringifying the
  // array: an element JSON has no text for is "null" inside an array and nothing at all on its own.
  it("writes null for an element with no JSON of its own, as an array's JSON does", () => {
    const holed = [1, undefined, 2]

    expect(checksumEntries(holed)).toBe(fnv1a64Checksum("[1,null,2]"))
    expect(checksumEntries(holed)).toBe(fnv1a64Checksum(JSON.stringify(holed)))
  })
})

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
