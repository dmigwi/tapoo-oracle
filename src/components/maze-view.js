// The maze replay: a decoded grid with the round's traversal scrubbed one turn at a time.
//
// Built imperatively rather than as an htl template, matching createReportTabsInput in oracle.js. The
// scrubber repaints on every input event, and rebuilding a template per frame would discard and
// recreate the whole grid on each step; here only the overlay is redrawn while the walls stay put.
//
// It deliberately owns no Observable cell. The page's reactive graph is one state cell, and a slider
// added to it would rebuild every report section per frame. A plain input listener also sidesteps
// Observable's generator pumping, which is driven by requestAnimationFrame and does not run while the
// document is hidden.

import { MOVES, cellKey, classifyTraversalSpeed } from "../contracts/log-contract.js";
import { mazeFromEncoded } from "../contracts/maze.js";
import { formatCount } from "./oracle.js";

// --- Model ---

// The maze replay owns its own data shaping. These were in oracle.js, under the rule that oracle
// holds adapters and view modules hold DOM - but nothing outside this file uses them, and the split
// meant reaching into a module about reports for two functions only the maze calls. Pure and
// document-free, so they stay testable without a DOM.


// mazeReplayModel turns each played round into everything the maze view needs, or the reason it cannot
// be drawn.
//
// The maze is not optional context: a traversal drawn on a grid that failed its checksum would be a
// picture of damaged bytes presented as evidence. So a round that cannot be decoded carries an error
// instead of a partial grid, and the view renders the error.
export function mazeReplayModel(report) {
  const levels = report?.levels ?? [];

  return levels.map((level) => {
    const destination = level.destinationCell
      ? cellKey(level.destinationCell.row, level.destinationCell.col)
      : null;
    const built = mazeFromEncoded(level.encodedMaze, {
      startCell: level.startCell,
      destinationCell: destination
    });

    // Colour is assigned per player in first-acting order, so a seat keeps the same colour across every
    // level of a log rather than changing when another seat happens to move first.
    const agents = [];
    for (const turn of level.turns) {
      if (turn.playerName && !agents.includes(turn.playerName)) agents.push(turn.playerName);
    }

    return {
      key: level.key,
      game: level.game,
      level: level.level,
      label: `Level ${level.level}${levels.length > 1 ? ` (game ${level.game})` : ""}`,
      maze: built.ok ? built.maze : null,
      error: built.ok ? null : built.error,
      stats: built.ok ? built.stats : null,
      startCell: level.startCell,
      destinationCell: destination,
      endCell: level.endCell,
      observedExits: level.observedExits,
      turns: level.turns,
      outcome: level.outcome,
      agents
    };
  });
}

// mazeFrameAt reports the state of the replay after `turnIndex` turns have been played.
//
// Pure, and the only thing the scrubber calls: keeping the frame a value rather than mutating the view
// means every position it can show is reachable in a test without a browser.
export function mazeFrameAt(levelModel, turnIndex) {
  const played = levelModel.turns.slice(0, Math.max(0, Math.min(turnIndex, levelModel.turns.length)));
  const visited = new Map();

  if (levelModel.startCell) visited.set(levelModel.startCell, null);
  for (const turn of played) {
    for (const cell of turn.cells) visited.set(cell, turn.playerName);
  }

  const current = played.at(-1);
  const positions = new Map();
  for (const turn of played) {
    if (turn.playerName && turn.cells.length > 0) positions.set(turn.playerName, turn.cells.at(-1));
  }

  return {
    // The turns this frame covers. Returned rather than recomputed by the caller: drawFrame needed the
    // whole level model purely to slice this same range again.
    played,
    turnIndex: played.length,
    totalTurns: levelModel.turns.length,
    visited,
    positions,
    currentCell: current?.cells.at(-1) ?? levelModel.startCell ?? null,
    // The wall the agent walked into on this turn, if any. Drawn only for the current turn: a rejected
    // move is an event, not a lasting property of the cell.
    rejected: current?.rejectedMove ? {cell: current.cells.at(-1), move: current.rejectedMove} : null,
    turn: current ?? null
  };
}

// mazeSummaryRows describes the maze itself and how much of it the round actually used.
export function mazeSummaryRows(levelModel) {
  if (!levelModel?.stats) return [];

  const stats = levelModel.stats;
  const walked = new Set(levelModel.turns.flatMap((turn) => turn.cells));
  if (levelModel.startCell) walked.add(levelModel.startCell);
  const outcome = levelModel.outcome ?? {};
  const agentCells = Number(outcome.playerUniqueCellsVisited);
  const coverage = stats.cells > 0 ? Math.round((walked.size / stats.cells) * 100) : 0;

  return [
    {field: "Maze size", value: `${stats.rows} x ${stats.cols} (${formatCount(stats.cells)} cells)`},
    {field: "Dead ends", value: formatCount(stats.deadEnds)},
    {field: "Corridors", value: formatCount(stats.corridors)},
    {field: "Junctions", value: formatCount(stats.junctions)},
    {
      field: "Shortest route",
      value: stats.shortestPath === null ? "no route found" : `${formatCount(stats.shortestPath)} moves`
    },
    {field: "Cells entered", value: `${formatCount(walked.size)} of ${formatCount(stats.cells)} (${coverage}%)`},
    {
      // Tapoo credits the start cell to the "Self" pseudo-player, so an agent's own unique-cell count is
      // one below the cells its path covers. Reporting both stops that gap reading as an error.
      field: "Credited to agent",
      value: Number.isFinite(agentCells) ? formatCount(agentCells) : "not recorded"
    },
    {
      field: "Decay charged",
      value: Number.isFinite(Number(outcome.decayUnitsCharged))
        ? formatCount(outcome.decayUnitsCharged)
        : "not recorded"
    }
  ];
}

// levelSummaryRows gives one row per played round, so a multi-level log reads as a sequence rather than
// a single aggregate.
export function levelSummaryRows(report) {
  return (report?.levels ?? []).map((level) => {
    const outcome = level.outcome ?? {};
    const speed = Number(outcome.traversalSpeed);

    return {
      level: level.level ?? "-",
      game: level.game ?? "-",
      outcome: outcome.outcome ?? "unfinished",
      turns: level.turns.length,
      // Classified here rather than read from the log: the log's own class field is lower-cased, and two
      // spellings of the same class in one report read as two different things.
      speed: Number.isFinite(speed) ? speed.toFixed(4) : "not recorded",
      class: Number.isFinite(speed) ? classifyTraversalSpeed(speed) : "not recorded"
    };
  });
}

// --- Drawing constants ---

const SVG_NS = "http://www.w3.org/2000/svg";

// CELL is the drawn size of one maze cell. The SVG scales to its container, so this only fixes the
// coordinate system and the relative weight of strokes within it.
const CELL = 32;

// AGENT_COLORS distinguishes seats. Tapoo allows five, and the palette is ordered so the first seat
// gets the app's own accent rather than an arbitrary hue.
const AGENT_COLORS = [
  "var(--oracle-terracotta)",
  "var(--oracle-sage)",
  "var(--oracle-amber)",
  "#4a5f8a",
  "#6c4a7a"
];

// --- Element helpers ---

const createSvgElement = (name, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

const createHtmlElement = (name, className, text) => {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const cellXY = (cell) => {
  const [row, col] = cell.split(",").map(Number);
  return {row, col, x: col * CELL, y: row * CELL};
};

// --- Static layers ---

// drawWalls renders the static maze once. Every edge a cell has no exit through becomes a line, so
// interior walls are drawn twice - once from each side - which costs nothing and avoids having to
// special-case the outer boundary.
function drawWalls(svg, maze) {
  const walls = createSvgElement("g", {stroke: "var(--oracle-ink)", "stroke-width": 2, "stroke-linecap": "square"});
  for (const [cell, open] of maze.exits) {
    const {x, y} = cellXY(cell);
    const edges = {
      MoveUp: [x, y, x + CELL, y],
      MoveDown: [x, y + CELL, x + CELL, y + CELL],
      MoveLeft: [x, y, x, y + CELL],
      MoveRight: [x + CELL, y, x + CELL, y + CELL]
    };
    for (const [move, [x1, y1, x2, y2]] of Object.entries(edges)) {
      if (!open.has(move)) walls.append(createSvgElement("line", {x1, y1, x2, y2}));
    }
  }
  svg.append(walls);
}

// markerFor draws the fixed points of the round: where it began and where it had to end.
function drawMarkers(svg, model) {
  if (model.destinationCell) {
    const {x, y} = cellXY(model.destinationCell);
    svg.append(
      createSvgElement("rect", {
        x: x + 6, y: y + 6, width: CELL - 12, height: CELL - 12,
        fill: "none", stroke: "var(--oracle-rose)", "stroke-width": 2
      })
    );
  }
  if (model.startCell) {
    const {x, y} = cellXY(model.startCell);
    svg.append(
      createSvgElement("circle", {cx: x + CELL / 2, cy: y + CELL / 2, r: 3, fill: "var(--oracle-muted)"})
    );
  }
}

// --- The scrubbed frame ---

// drawFrame paints everything that changes as the scrubber moves. Kept in its own group so a repaint
// removes exactly the previous frame and never the walls beneath it.
function drawFrame(overlay, frame, colorOf) {
  overlay.replaceChildren();

  // Visited cells are tinted. --oracle-selected is only 1.12:1 against paper so it never signals alone,
  // and the agent-coloured trail drawn below is its second cue: every visited cell lies on that path by
  // construction. An earlier version added a coloured bar along each cell's lower edge instead, which
  // was the same weight and orientation as a wall and read as one - it made the maze look like it had
  // walls the log never described.
  for (const cell of frame.visited.keys()) {
    const {x, y} = cellXY(cell);
    overlay.append(
      createSvgElement("rect", {
        x: x + 1, y: y + 1, width: CELL - 2, height: CELL - 2,
        fill: "var(--oracle-selected)", opacity: 0.85
      })
    );
  }

  // The path walked so far, per agent, so crossing trails stay tellable apart.
  const byAgent = new Map();
  for (const turn of frame.played) {
    const name = turn.playerName ?? "";
    if (!byAgent.has(name)) byAgent.set(name, []);
    byAgent.get(name).push(...turn.cells);
  }
  for (const [name, cells] of byAgent) {
    if (cells.length < 2) continue;
    const points = cells.map((cell) => {
      const {x, y} = cellXY(cell);
      return `${x + CELL / 2},${y + CELL / 2}`;
    });
    overlay.append(
      createSvgElement("polyline", {
        points: points.join(" "), fill: "none", stroke: colorOf(name),
        "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.9
      })
    );
  }

  // The refused move: a cross on the wall it was aimed through. This is the clearest single piece of
  // evidence on the grid, and it belongs only to the turn that produced it.
  //
  // Marked by shape rather than by colour. Rose and terracotta are both muted reds a few degrees apart,
  // so a rose stub laid against the terracotta trail was distinguishable only by hue - unreadable at
  // cell size, and invisible to a red-green colour deficiency. A cross is a different mark from a line
  // at any size, and the paper-coloured halo under it keeps it legible over both the trail and the
  // visited tint.
  if (frame.rejected?.cell && MOVES[frame.rejected.move]) {
    const {x, y} = cellXY(frame.rejected.cell);
    const [rowDelta, colDelta] = MOVES[frame.rejected.move];
    const cx = x + CELL / 2 + colDelta * (CELL / 2);
    const cy = y + CELL / 2 + rowDelta * (CELL / 2);
    const arm = 4.5;
    const strokes = [
      [cx - arm, cy - arm, cx + arm, cy + arm],
      [cx - arm, cy + arm, cx + arm, cy - arm]
    ];

    for (const [width, stroke] of [[5, "var(--oracle-paper)"], [2.5, "var(--oracle-rose)"]]) {
      for (const [x1, y1, x2, y2] of strokes) {
        overlay.append(
          createSvgElement("line", {x1, y1, x2, y2, stroke, "stroke-width": width, "stroke-linecap": "round"})
        );
      }
    }
  }

  for (const [name, cell] of frame.positions) {
    const {x, y} = cellXY(cell);
    overlay.append(
      createSvgElement("circle", {
        cx: x + CELL / 2, cy: y + CELL / 2, r: 7,
        fill: colorOf(name), stroke: "var(--oracle-paper)", "stroke-width": 2
      })
    );
  }
}

// turnNarrative is the scrubber's spoken label and its caption, so what the grid shows is also stated in
// words - a colour-coded path is not readable to everyone looking at it.
function turnNarrative(frame) {
  if (frame.turnIndex === 0) return "Start position, before the first turn.";

  const turn = frame.turn;
  const applied = turn.applied;
  const submitted = turn.moves.length;
  const who = turn.playerName ? `${turn.playerName} ` : "";
  const landed =
    applied === null
      ? "the log does not settle how many applied"
      : `${applied} of ${submitted} applied`;
  const wall = turn.rejectedMove ? `, ${turn.rejectedMove} refused` : "";

  return `Turn ${turn.turn}: ${who}submitted ${turn.moves.join(", ")} - ${landed}${wall}.`;
}

// --- Summaries ---

function summaryTable(rows, headers) {
  const table = createHtmlElement("table", "maze-summary-table");
  const head = createHtmlElement("thead");
  const headRow = createHtmlElement("tr");
  for (const header of headers) headRow.append(createHtmlElement("th", null, header));
  head.append(headRow);
  table.append(head);

  const body = createHtmlElement("tbody");
  for (const row of rows) {
    const tr = createHtmlElement("tr");
    for (const value of Object.values(row)) tr.append(createHtmlElement("td", null, String(value)));
    body.append(tr);
  }
  table.append(body);
  return table;
}

// --- Entry point ---

// createMazeReplay builds the whole section for one report and returns its root node.
export function createMazeReplay(report) {
  // Takes the report, not a pre-built model: both adapters live in this module, and having the caller
  // run them meant the view's own data shaping was spelled out at every call site.
  const models = mazeReplayModel(report);
  const levelSummary = levelSummaryRows(report);

  const root = createHtmlElement("section", "maze-replay");
  root.setAttribute("aria-label", "Maze traversal timeline replay");

  if (models.length === 0) return root;

  const heading = createHtmlElement("h2", "maze-heading", "Maze Traversal Timeline Replay");
  root.append(heading);

  const controls = createHtmlElement("div", "maze-controls");
  const select = createHtmlElement("select", "maze-level-select");
  select.setAttribute("aria-label", "Level to replay");
  models.forEach((model, index) => {
    const option = createHtmlElement("option", null, model.label);
    option.value = String(index);
    select.append(option);
  });
  if (models.length > 1) controls.append(select);
  root.append(controls);

  const figure = createHtmlElement("div", "maze-figure");
  const caption = createHtmlElement("p", "maze-caption");
  const scrubberRow = createHtmlElement("div", "maze-scrubber");
  const range = createHtmlElement("input");
  range.type = "range";
  range.className = "maze-range";
  const readout = createHtmlElement("span", "maze-readout");
  scrubberRow.append(range, readout);

  const summary = createHtmlElement("div", "maze-summary");
  root.append(figure, caption, scrubberRow, summary);

  let active = models[0];

  const colorOf = (name) => {
    const index = active.agents.indexOf(name);
    return AGENT_COLORS[(index < 0 ? 0 : index) % AGENT_COLORS.length];
  };

  let overlay = null;

  const paint = () => {
    const frame = mazeFrameAt(active, Number(range.value));
    if (overlay) drawFrame(overlay, frame, colorOf);
    caption.textContent = turnNarrative(frame);
    readout.textContent = `${frame.turnIndex} / ${frame.totalTurns}`;
    range.setAttribute("aria-valuetext", turnNarrative(frame));
  };

  const showLevel = (model) => {
    active = model;
    figure.replaceChildren();
    summary.replaceChildren();

    if (!model.maze) {
      // A round with no usable maze is reported, not skipped: the profile beside it is still real, and
      // silently dropping the grid would read as "this round had nothing worth showing".
      const notice = createHtmlElement("div", "notice notice-error");
      notice.append(createHtmlElement("strong", null, "Maze unavailable for this round"));
      notice.append(createHtmlElement("span", null, model.error));
      notice.append(
        createHtmlElement(
          "span",
          null,
          "A round resumed from a saved snapshot, or logs reset mid-round, never write the level-started entry that carries the maze."
        )
      );
      figure.append(notice);
      scrubberRow.hidden = true;
      caption.textContent = "";
      return;
    }

    scrubberRow.hidden = false;
    const svg = createSvgElement("svg", {
      viewBox: `-2 -2 ${model.maze.cols * CELL + 4} ${model.maze.rows * CELL + 4}`,
      class: "maze-grid",
      role: "img",
      "aria-label": `${model.maze.rows} by ${model.maze.cols} maze with the traversal drawn on it`
    });
    drawWalls(svg, model.maze);
    drawMarkers(svg, model);
    overlay = createSvgElement("g", {class: "maze-overlay"});
    svg.append(overlay);
    figure.append(svg);

    range.min = "0";
    range.max = String(model.turns.length);
    range.value = String(model.turns.length);
    range.setAttribute("aria-label", `Turn to show, 0 to ${model.turns.length}`);

    summary.append(
      summaryTable(mazeSummaryRows(model), ["Maze", "Value"]),
      levelSummary.length > 0
        ? summaryTable(levelSummary, ["Level", "Game", "Outcome", "Turns", "Speed", "Class"])
        : createHtmlElement("div")
    );

    paint();
  };

  range.addEventListener("input", paint);
  select.addEventListener("change", () => showLevel(models[Number(select.value)]));

  showLevel(models[0]);
  return root;
}
