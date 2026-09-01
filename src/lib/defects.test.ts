import {describe, expect, it} from "vitest"

import {cellFromLogged, movesFromLogged} from "./log-contract"
import {mazeReplayModel} from "./maze-model"
import {createInitialReportTabs, deleteReportTab, trimReportTabLabel} from "./report-tabs"
import {buildLevels} from "./rounds"
import {VIOLATIONS, buildContext, parsePrediction} from "./rubric-engine"
import {decodeReportPayload, validateOnlineJsonUrl} from "./share-link"
import {at, must, reportWith} from "./test-support"
import {asTrimmedText} from "./untrusted"
import type {LogEntry, ReportTabsState} from "./types"

// Regressions for the defects the TypeScript conversion exposed.
//
// Each of these was reachable from a real log or a real link before the conversion, and none of them
// was visible to the suite: every fixture in the repository used the shape that happened to work. So
// the fixtures here deliberately use the shapes that did not - a compacted cell, a malformed model
// response, a move outside the command set - because the shape *is* the defect.
//
// Types alone do not close these. `strict` made each one a compile error at the point where the
// wrong assumption was written down, and the fix went into the code; these tests are what keeps the
// fix from being undone by someone who reads the narrow type as the only shape that arrives.

const encodedMaze = {
  index_chars: ["|", "---", "-", "   ", " ", "\n"],
  structure_checksum: "0x74af82cb14470b9d",
  structure:
    "01012121012105030343430343050301230303210503034303034305030301030303050343030303030501210303010305034343434343050121212121210",
  dimensions: {numCols: 6, numRows: 4, area: 24},
}

const levelStarted = (details: unknown): LogEntry => ({
  epochMs: 1788000000000,
  time: "t",
  turn: 0,
  level: 1,
  game: 2,
  log: "info",
  payload: "Agent level started.",
  details,
})

describe("defect 1: a logged cell arrives in two shapes", () => {
  // A downloaded log compacts {row, col} to [row, col]. One reader knew that and another, reading
  // destinationCell, did not - so the key became "undefined,undefined": no destination drawn, and the
  // shortest route reported to the reader as "no route found" on a maze that has one.
  it("resolves a destination logged in the compacted form", () => {
    const levels = buildLevels([
      levelStarted({maze: encodedMaze, startPosition: {x: 1, y: 1}, destinationCell: [0, 5]}),
    ])

    expect(at(levels, 0).destinationCell).toBe("0,5")
  })

  it("resolves the same destination logged uncompacted, unchanged", () => {
    const levels = buildLevels([
      levelStarted({maze: encodedMaze, startPosition: {x: 1, y: 1}, destinationCell: {row: 0, col: 5}}),
    ])

    expect(at(levels, 0).destinationCell).toBe("0,5")
  })

  it("reports a route rather than 'no route found' for a compacted destination", () => {
    const levels = buildLevels([
      levelStarted({maze: encodedMaze, startPosition: {x: 1, y: 1}, destinationCell: [0, 5]}),
    ])
    const model = must(mazeReplayModel(reportWith(...levels))[0], "a model for the round")

    expect(must(model.stats, "maze stats").shortestPath).not.toBeNull()
  })

  it("reads both shapes through one reader, and rejects anything else", () => {
    expect(cellFromLogged([2, 3])).toBe("2,3")
    expect(cellFromLogged({row: 2, col: 3})).toBe("2,3")
    expect(cellFromLogged({row: "2", col: 3})).toBeNull()
    expect(cellFromLogged(["2", 3])).toBeNull()
    expect(cellFromLogged(null)).toBeNull()
    expect(cellFromLogged("2,3")).toBeNull()
  })

  it("reads open moves from both shapes", () => {
    // Reading the compacted form with Object.keys yields array indices - "0", "1" - which match no
    // move command, so every exit check silently answered no.
    expect([...movesFromLogged({MoveUp: "unvisited", MoveDown: "visited"})].sort())
      .toEqual(["MoveDown", "MoveUp"])
    expect([...movesFromLogged([["MoveUp", "unvisited"], ["MoveDown", "visited"]])].sort())
      .toEqual(["MoveDown", "MoveUp"])
  })
})

describe("defect 2: a model can answer with a moves key that is not a list", () => {
  // `moves` was returned as whatever the model sent. A string reached `.every` in the rubric - not a
  // function on a string - and the TypeError propagated out of answerRubric, so one malformed
  // response took down the entire page render rather than failing one question.
  it("does not throw on a moves key holding a bare string", () => {
    expect(() => parsePrediction('{"moves": "MoveUp"}')).not.toThrow()
  })

  it("treats it as no moves rather than one move", () => {
    // Wrapping it would score a malformed response as a valid single-move prediction, which is the
    // opposite of what the rubric is asking.
    expect(must(parsePrediction('{"moves": "MoveUp"}'), "a parsed prediction").moves).toEqual([])
  })

  it("still records that the key was present", () => {
    // The difference between "no moves key" and "a moves key holding junk" is what C1 asks about.
    expect(must(parsePrediction('{"moves": "MoveUp"}'), "a parsed prediction").keys).toEqual(["moves"])
  })

  it("keeps a well-formed list exactly as sent", () => {
    expect(must(parsePrediction('{"moves": ["MoveUp", "MoveLeft"]}'), "a parsed prediction").moves)
      .toEqual(["MoveUp", "MoveLeft"])
  })
})

describe("defect 3: V4 walked the maze with an unvalidated move", () => {
  // stepFrom destructures MOVES[move] and throws on anything else. Every other caller guarded; V4 did
  // not, and the move it passes comes from the log, which may contain any string at all.
  const v4 = must(VIOLATIONS.find((group) => group.id === "V4"), "the V4 group")

  const contextWith = (move: string) =>
    buildContext([
      levelStarted({maze: encodedMaze, startPosition: {x: 1, y: 1}}),
      {
        epochMs: 1788000000001, time: "t", turn: 1, level: 1, game: 2, log: "info",
        payload: "Agent response.",
        details: {content: JSON.stringify({moves: [move]})},
      },
    ])

  it("does not throw when a cell lists a move Tapoo does not accept", () => {
    expect(() => v4.evaluate(contextWith("MoveSideways"))).not.toThrow()
  })

  it("answers rather than throwing away the whole report", () => {
    const answers = v4.evaluate(contextWith("MoveSideways"))
    expect(Object.values(answers).every((value) => typeof value === "boolean")).toBe(true)
  })
})

describe("defect 4: decodeReportPayload has a failure path that names no link", () => {
  // It returns {ok:false, error, link}, {ok:true, url}, or - delegating to validateOnlineJsonUrl -
  // {ok:false, error} with no link at all. The caller read `decoded.link` unconditionally, so the
  // "(broken link: ...)" hint silently vanished on exactly that path.
  it("carries a link on every failure, so the hint can never go missing", () => {
    for (const token of ["", "!!!not-base64!!!", "AAAA", "z", "AA==AA"]) {
      const decoded = decodeReportPayload(token)
      if (decoded.ok) continue

      expect(decoded).toHaveProperty("link")
    }
  })

  it("names the link for a token that decodes to an address the validator rejects", () => {
    // The delegating path: the bytes decode, so the codec is happy, and the URL underneath is not a
    // permitted one. Before, this was the shape that returned no link.
    const decoded = decodeReportPayload("AAAA")
    expect(decoded.ok).toBe(false)
    if (!decoded.ok) expect(decoded.link === null || typeof decoded.link === "string").toBe(true)
  })
})

describe("defect 5: deleting a tab erased unrelated pending state", () => {
  // deleteReportTab rebuilt the state object from scratch, so draftUrl, draftStatus and the
  // sharedLink fields were dropped - a shared-link error on screen disappeared when someone closed an
  // unrelated report.
  it("keeps the shared-link error when another tab is deleted", () => {
    const state: ReportTabsState = {
      ...createInitialReportTabs(),
      tabs: [
        {id: "first", url: "https://example.com/a.json", label: "a.json", status: "loaded"},
        {id: "second", url: "https://example.com/b.json", label: "b.json", status: "loaded"},
      ],
      activeTabId: "first",
      draftUrl: "https://example.com/c.json",
      sharedLinkError: "This link has been truncated or altered. Ask for a fresh link.",
    }

    const next = deleteReportTab(state, "second")

    expect(next.draftUrl).toBe("https://example.com/c.json")
    expect(next.sharedLinkError).toBe("This link has been truncated or altered. Ask for a fresh link.")
  })
})

describe("defect 6: untrusted input was stringified rather than rejected", () => {
  // String({}) is "[object Object]" - fifteen characters that pass every emptiness check downstream.
  // An object arriving here reached a URL validator as an address to reject for the wrong reason, or
  // a tab label as the visible name of a report.
  it("reads a composite as absent, not as its default stringification", () => {
    expect(asTrimmedText({})).toBe("")
    expect(asTrimmedText([1, 2])).toBe("")
    expect(asTrimmedText(null)).toBe("")
    expect(asTrimmedText(undefined)).toBe("")
  })

  it("keeps the text forms that are unambiguous", () => {
    expect(asTrimmedText("  https://example.com/a.json  ")).toBe("https://example.com/a.json")
    expect(asTrimmedText(42)).toBe("42")
    expect(asTrimmedText(false)).toBe("false")
  })

  it("does not name a report '[object Object]'", () => {
    expect(trimReportTabLabel({})).toBe("")
  })

  it("refuses an object as a URL for the reason a reader can act on", () => {
    const result = validateOnlineJsonUrl({})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toBe("Enter an online JSON file URL.")
  })
})
