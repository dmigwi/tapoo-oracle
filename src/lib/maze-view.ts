// The maze replay: a decoded grid with the round's traversal scrubbed one turn at a time.
//
// Built imperatively rather than as an htl template. The scrubber repaints on every input event, and
// rebuilding a template per frame would discard and recreate the whole grid on each step; here only
// the overlay is redrawn while the walls stay put.
//
// It deliberately owns no Observable cell. The page's reactive graph is one state cell, and a slider
// added to it would rebuild every report section per frame. A plain input listener also sidesteps
// Observable's generator pumping, which is driven by requestAnimationFrame and does not run while the
// document is hidden.

import { agentSeatLabel, cellFromKey, classifyTraversalSpeed, getCellKey, isMove } from "./log-contract"
import { DECAY_REASONS, MOST_DECAY, agentIndexOf, decayTally, mazeFrameAt, mazeLevelRows, mazeReplayModel, mazeStructureRows } from "./maze-model"
import { capitalize, formatCount } from "./utils"
import type { AgentSummary, CellKey, Frame, PlayedRound, ReplayModel, Maze, Move, SummaryRow, VisitStatus } from "./types"

// --- Entry point: what report-view calls ---

/** createMazeReplay builds the whole section for the round on screen and returns its root node.
 *
 * Takes the round, not the report it came from: this section draws one maze, and a verdict is not one
 * of its inputs. `null` renders the empty section, for a report that answered no round.
 *
 * Shapes its own data from there, so the page hands over a round rather than a pre-built model. */
export function createMazeReplay(round: PlayedRound | null): HTMLElement {
  const replayModel = mazeReplayModel(round);

  const root = createHtmlElement("section", "maze-replay");
  root.setAttribute("aria-label", "Maze traversal timeline replay");

  if (!replayModel) return root;

  const heading = createHtmlElement("h2", "maze-heading", "Maze Traversal Timeline Replay");
  root.append(heading);

  // A mode rather than a bare hover behaviour. Hovering a grid does nothing anywhere else on this page,
  // so a lens that only appeared on hover would be invisible until stumbled into - and a reader who does
  // not want it keeps a grid that behaves normally.
  const magnify = createHtmlElement("button", "maze-magnify") as HTMLButtonElement;
  magnify.type = "button";
  magnify.setAttribute("aria-pressed", "false");
  // The label states what the button is doing, not only what it would do. aria-pressed already carries
  // that to a screen reader; this is the same fact for everyone else, and it is the difference between
  // a button that looks selected and one that says so.
  const magnifyLabel = createHtmlElement("span", null, "Magnify");
  magnify.append(magnifierIcon(), magnifyLabel);

  const figure = createHtmlElement("div", "maze-figure");
  const caption = createHtmlElement("p", "maze-caption");
  const scrubberRow = createHtmlElement("div", "maze-scrubber");
  // The two bar strips and the slider share one horizontal space, so a bar sits under the position it
  // describes. The track carries the inline padding that keeps them aligned with the thumb.
  const track = createHtmlElement("div", "maze-track");
  const movesStrip = createHtmlElement("div", "maze-bars maze-bars-moves");
  const decayStrip = createHtmlElement("div", "maze-bars maze-bars-decay");
  const range = createHtmlElement("input") as HTMLInputElement;
  range.type = "range";
  range.className = "maze-range";
  const readout = createHtmlElement("span", "maze-readout");
  track.append(movesStrip, range, decayStrip);
  scrubberRow.append(track, readout);

  // Rebuilt when the round changes, not when the scrubber moves.
  let movesBars: HTMLElement[] = [];
  let decayBars: HTMLElement[] = [];

  // Beside the grid it describes, not down with the decay legend: it is a key to the maze, and a key
  // reads where the thing it explains is. The stage puts the two on one row while there is width for
  // both and lets the key drop underneath when there is not.
  const stage = createHtmlElement("div", "maze-stage");
  // The lens takes the column the key sits in, above it, so the magnified view reads at the same height
  // as the grid it is reading. With the mode off the column is the key alone.
  const aside = createHtmlElement("div", "maze-aside");
  const lens = createHtmlElement("div", "maze-lens");
  // The button lives inside the lens, and the body is what gets replaced on every paint - so the
  // control survives the redraw that rebuilds the view around it.
  const lensBody = createHtmlElement("div", "maze-lens-body");
  const visitLegend = createHtmlElement("ul", "maze-legend maze-visit-legend");
  // Directly above the panel it opens, rather than off in the controls row: the button and the view it
  // produces are one thing, and a control that sits apart from its effect has to be connected by the
  // reader before it means anything.
  lens.append(magnify, lensBody);
  aside.append(lens, visitLegend);
  stage.append(figure, aside);
  const legend = createHtmlElement("ul", "maze-legend maze-decay-legend");
  const summary = createHtmlElement("div", "maze-summary");
  root.append(stage, caption, scrubberRow, legend, summary);

  // The round on screen. A report answers one round, so this is set once - showLevel still owns it,
  // because it is what wires the frame, the scrubber and the panels to a model.
  let active: ReplayModel = replayModel;

  // The lens is a view concern, so its state lives here rather than on the Frame: paint() replaces the
  // overlay on every scrub, and these two have to survive that.
  let magnifying = false;
  let focused: CellKey | null = null;

  // Keyed by the seat's place in the round's roster, resolved once by agentIndexOf so the trail, the
  // marker and the stats card beside them all name the same seat. -1 is a turn no seat claims, which
  // takes the first colour rather than none at all: an uncoloured trail reads as a wall.
  const colorOf = (seat: number): string =>
    AGENT_COLORS[(seat < 0 ? 0 : seat) % AGENT_COLORS.length] ?? AGENT_COLORS[0]!;

  let overlay: SVGElement | null = null;

  // The radius the log recorded, or ours. A null radius means the log never said what the agent could
  // see, so the lens still magnifies but stops claiming to be that window.
  const lensRadius = (): number => active.historyWindowRadius ?? DEFAULT_LENS_RADIUS;
  const claimsAgentWindow = (): boolean => active.historyWindowRadius !== null;

  const paintLens = (frame: Frame): void => {
    lensBody.replaceChildren();
    // Open is a class, not `hidden`: the button is inside this box and has to stay reachable when there
    // is no view yet. Closed, the box carries no border or padding, so it is the button and nothing else.
    lens.classList.toggle("is-open", magnifying);
    if (!magnifying) return;

    // Opens on the agent's current cell, so turning the mode on shows something at once - and that
    // default is the useful one, because it is the window the agent actually had this turn.
    const cell = focused ?? frame.currentCell;
    if (cell === null) return;

    const radius = lensRadius();
    const grid = buildLens(active, frame, cell, radius, claimsAgentWindow(), colorOf);
    if (grid) lensBody.append(grid);

    // "Visited cells", not "what the agent could see". The radius bounds which cells could be reported;
    // it does not mean they were. The agent is only told about ground it has already entered, so the
    // walls this lens draws on ground it never walked come from our decoded maze and were never in front
    // of the model - which the caveat says, because the drawing itself invites the opposite reading.
    const note = createHtmlElement(
      "p",
      "maze-lens-note",
      claimsAgentWindow()
        ? `Visited cells the agent can see from ${spellCell(cell)} - ${formatCount(radius)} cells out`
        : `Magnified around ${spellCell(cell)}; the log did not record how far the history window reached`,
    );
    note.append(
      createHtmlElement(
        "span",
        "maze-lens-caveat",
        "The unvisited structure drawn here was never exposed to it.",
      ),
    );
    lensBody.append(note);
  };

  const paint = (): void => {
    const frame = mazeFrameAt(active, Number(range.value));
    if (overlay) drawFrame(overlay, frame, active, colorOf);
    caption.textContent = turnNarrative(frame, active);
    // The log's own turn number, the same identifier the caption and the bar tooltips use - read from
    // frame.turn so the two cannot drift. `turnIndex / totalTurns` counts turns *played* instead, which
    // reads "16 / 16" beside a caption saying "Turn 15".
    const last = active.turns.at(-1)?.turn;
    readout.textContent = frame.turn === null || last === undefined ? "Start" : `Turn ${frame.turn.turn} / ${last}`;
    range.setAttribute("aria-valuetext", turnNarrative(frame, active));

    // The strips and the slider have to agree about where you are. Toggling classes on kept references
    // is the whole update - the bars themselves do not change as you scrub.
    //
    // The slider fades its track ahead of the thumb; the strips fade the turns ahead of it, so all
    // three read as one control rather than a slider with two decorations beside it.
    buildVisitLegend(visitLegend, active, frame);
    buildDecayLegend(legend, frame, decayStrip.hidden === true);
    paintLens(frame);

    const current = frame.turnIndex - 1;
    const total = Number(range.max);
    range.style.setProperty("--progress", `${total > 0 ? (frame.turnIndex / total) * 100 : 0}%`);
    for (const bars of [movesBars, decayBars]) {
      for (const [index, bar] of bars.entries()) {
        bar.classList.toggle("is-current", index === current);
        bar.classList.toggle("is-future", index > current);
      }
    }
  };

  // Moving a pointer across a large grid fires an event per pixel of travel. Rebuilding 25 cells each
  // time is waste the lens does not need, so a move that stays inside the same cell does nothing.
  const focusCell = (cell: CellKey | null): void => {
    if (!magnifying || cell === null || cell === focused) return;
    focused = cell;
    paint();
  };

  const cellUnder = (target: EventTarget | null): CellKey | null =>
    target instanceof Element ? target.getAttribute("data-cell") : null;

  magnify.addEventListener("click", () => {
    magnifying = !magnifying;
    magnify.setAttribute("aria-pressed", String(magnifying));
    magnify.classList.toggle("is-on", magnifying);
    magnifyLabel.textContent = magnifying ? "Magnifying" : "Magnify";
    figure.classList.toggle("is-magnifying", magnifying);
    // Released rather than remembered: turning the mode back on should start where the agent is, not
    // wherever the pointer happened to leave the grid a while ago.
    if (!magnifying) focused = null;
    paint();
  });

  figure.addEventListener("pointerover", (event) => focusCell(cellUnder(event.target)));
  // Touch has no hover, so a tap has to count as one or the mode does nothing on a phone.
  figure.addEventListener("click", (event) => focusCell(cellUnder(event.target)));

  // The button is reachable by keyboard on its own; this is what makes the grid reachable once the mode
  // is on, so the lens is not a mouse-only feature.
  figure.addEventListener("keydown", (event) => {
    if (!magnifying) return;
    const step = ARROW_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const from = focused ?? mazeFrameAt(active, Number(range.value)).currentCell;
    if (from === null) return;
    const {row, col} = cellXY(from);
    const [rowStep, colStep] = step;
    const next = getCellKey({row: row + rowStep, col: col + colStep});
    if (active.maze?.exits.has(next)) focusCell(next);
  });

  const showLevel = (model: ReplayModel): void => {
    active = model;
    figure.replaceChildren();
    summary.replaceChildren();
    legend.replaceChildren();
    legend.hidden = true;
    visitLegend.replaceChildren();
    visitLegend.hidden = true;

    if (!model.maze) {
      // A round with no usable maze is reported, not skipped: the profile beside it is still real, and
      // silently dropping the grid would read as "this round had nothing worth showing".
      //
      // And reported *only* here. parseRound decodes the same maze and hands back the failure
      // without raising a warning of its own, because a notice above the round tabs said the same thing
      // less well: the reader is looking at the space the traversal should occupy, which is where they
      // can see what is missing from it.
      //
      // "Maze unavailable" was the heading, and it read as a temporary condition - something that might
      // load in a moment - rather than as a payload that arrived wrong or never arrived at all.
      const notice = createHtmlElement("div", "notice notice-error");
      notice.append(
        createHtmlElement("strong", null, "The encoded maze payload is missing or inaccurate")
      );
      notice.append(createHtmlElement("span", null, model.error));
      notice.append(
        createHtmlElement(
          "span",
          null,
          "Without it this round has no traversal replay and no maze statistics - no shortest route, " +
            "no dead ends, no count of the cells entered. Every rubric verdict beside it still stands: " +
            "the questions answer from the exits the log's own tool results confirmed, not from this payload."
        )
      );
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
    svg.append(ungradedHatch());
    drawWalls(svg, model.maze);
    overlay = createSvgElement("g", {class: "maze-overlay"});
    svg.append(overlay);
    // Markers last, so they paint above the overlay rather than under it.
    //
    // SVG has no z-index; paint order is document order. With the markers drawn before the overlay the
    // start marker was invisible at every frame: the start cell is in frame.visited from frame 0 by
    // construction, and the visited tint is a full-cell opaque rect, so it buried a mark that was being
    // drawn correctly the whole time. The destination only escaped because the agent has not reached it
    // yet - it would have gone the same way on the winning frame.
    //
    // Start and destination are the two fixed landmarks on the grid. They are what the trail is read
    // against, so nothing the trail draws should be able to hide them.
    // Above the overlay so it catches the pointer, below the markers so it cannot hide them.
    svg.append(hitLayer(model.maze));
    drawMarkers(svg, model);
    svg.setAttribute("tabindex", "0");
    figure.append(svg);

    range.min = "0";
    range.max = String(model.turns.length);
    range.value = String(model.turns.length);
    range.setAttribute("aria-label", `Turn to show, 0 to ${model.turns.length}`);

    // Built once per round. drawFrame runs on every scrub and has no business rebuilding 900 nodes.
    movesBars = buildMovesBars(movesStrip, model);
    decayBars = buildDecayBars(decayStrip, model);

    const levelPanel = createHtmlElement("div", "maze-summary-panel");
    levelPanel.append(
      createHtmlElement("h3", "maze-summary-heading", "Level"),
      // The Turns row is the one cell that carries colour, so the view swaps in the rendered tally over
      // the model's plain-text form of the same numbers.
      summaryTable(
        mazeLevelRows(model).map((row) => (row.field === "Turns" ? {...row, value: turnRow(model)} : row)),
        ["Property", "Value"],
      ),
    );
    if (model.stats && model.agents.length > 0) levelPanel.append(agentStatsRow(model));

    summary.append(
      summaryPanel("Maze", mazeStructureRows(model)),
      levelPanel,
    );

    paint();
  };

  range.addEventListener("input", paint);

  showLevel(replayModel);
  return root;
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

const createSvgElement = (name: string, attributes: Record<string, string | number> = {}): SVGElement => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
};

const createHtmlElement = (
  name: string,
  className?: string | null,
  text?: string | null,
): HTMLElement => {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// cellXY is the key's coordinates plus where they land on the canvas. cellFromKey does the reading, so
// nothing here splits the string itself: two readers of one format are free to disagree about which half
// is the row, and a drawing that disagrees with a key is a maze drawn transposed.
const cellXY = (cell: CellKey): {row: number; col: number; x: number; y: number} => {
  const {row, col} = cellFromKey(cell);
  return {row, col, x: col * CELL, y: row * CELL};
};

// --- Static layers ---

// The mark for a cell the log never graded. Diagonal hatching, the same idea the decay strip uses for a
// charge nobody reported and for the reason its comment gives: a missing measurement is not a
// measurement of nothing, and it must not borrow a colour from the scale.
//
// A pattern rather than the strip's repeating-linear-gradient, because an SVG `fill` cannot take a CSS
// gradient. The id is document-scoped, so it is namespaced rather than called something like "hatch" -
// there is one replay per page today, and that is not a thing to rely on.
const UNGRADED_PATTERN = "tapoo-maze-ungraded";

function ungradedHatch(): SVGElement {
  const defs = createSvgElement("defs");
  const pattern = createSvgElement("pattern", {
    id: UNGRADED_PATTERN, width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)"
  });
  pattern.append(
    createSvgElement("rect", {width: 6, height: 6, fill: "var(--oracle-surface)"}),
    createSvgElement("line", {x1: 0, y1: 0, x2: 0, y2: 6, stroke: "var(--oracle-line)", "stroke-width": 2}),
  );
  defs.append(pattern);
  return defs;
}

// The magnifier icon, drawn here rather than carried as a file.
//
// The svgrepo original was a filled outline - three paths tracing a hairline ring - which at 1em renders
// barely a pixel wide and reads as a smudge beside the button's own text weight. Stroked geometry
// instead, because then the weight is one number that can be set to match the label rather than a shape
// that has to be re-traced to change it.
//
// currentColor throughout, so the icon follows the button through its off and on states instead of
// staying dark on a sage background.
const MAGNIFIER_STROKE = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 3.2,
  "stroke-linecap": "round",
};

function magnifierIcon(): SVGElement {
  const svg = createSvgElement("svg", {
    viewBox: "0 0 24 24", class: "maze-magnify-icon", "aria-hidden": "true", focusable: "false"
  });
  svg.append(
    createSvgElement("circle", {cx: 10, cy: 10, r: 6.4, ...MAGNIFIER_STROKE}),
    createSvgElement("line", {x1: 14.9, y1: 14.9, x2: 20.4, y2: 20.4, ...MAGNIFIER_STROKE}),
  );
  return svg;
}

// A cell key spelled out for a reader. "11,19" is the key the code passes around and it is ambiguous on
// sight - row-then-column is a convention, not something the pair announces, and a maze that is not
// square makes guessing wrong quietly. Naming both is two words and removes the guess.
const spellCell = (cell: CellKey): string => {
  const {row, col} = cellXY(cell);
  return `row=${row}, col=${col}`;
};

// Arrow keys move the focused cell, so the mode is not mouse-only. A dozen lines, and the difference
// between a feature and one a keyboard cannot reach.
const ARROW_STEPS: Record<string, [number, number] | undefined> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

// The radius used when a log never recorded one.
//
// The lens still magnifies without it - magnification is a view control, ours to choose - but it stops
// claiming to be the agent's window: no cover, and a caption that says only what it is showing. The
// window is the log's to state, and we do not invent one.
const DEFAULT_LENS_RADIUS = 2;

// hitLayer gives every cell something to point at.
//
// Cells only get a rect once they have been visited, so on unvisited ground there is nothing under the
// pointer at all. Transparent rects over the whole grid fix that, and they carry the cell key rather
// than needing pointer coordinates mapped back through getBoundingClientRect - which reports zeros in
// jsdom, so a coordinate-based hit test could not be tested at all.
//
// Built once per round with the walls, not per frame: it does not change as the scrubber moves.
function hitLayer(maze: Maze): SVGElement {
  const layer = createSvgElement("g", {class: "maze-hits"});
  for (let row = 0; row < maze.rows; row += 1) {
    for (let col = 0; col < maze.cols; col += 1) {
      const rect = createSvgElement("rect", {
        x: col * CELL, y: row * CELL, width: CELL, height: CELL, fill: "transparent"
      });
      rect.setAttribute("data-cell", getCellKey({row, col}));
      layer.append(rect);
    }
  }
  return layer;
}

// lensViewBox crops the grid to the window around `cell`, which is the whole of the magnification: the
// same on-screen box showing 2r+1 cells instead of the maze's full width.
//
// Deliberately not clamped to the maze. Against an outer wall the window runs off the grid and the lens
// shows blank paper there, which is the truth - an agent in a corner has fewer cells in range. Sliding
// the crop back inside would centre the lens on a cell the agent was not standing on.
function lensViewBox(cell: CellKey, radius: number): string {
  const {row, col} = cellXY(cell);
  const span = (2 * radius + 1) * CELL;
  return `${(col - radius) * CELL} ${(row - radius) * CELL} ${span} ${span}`;
}

// The crop is a square; the window is a diamond. Cells in the corners are inside the viewBox and outside
// the reporting radius, so they are covered - the lens shows the shape of the window rather than a
// rectangle that overstates it. This is what makes it the agent's window and not a generic zoom.
//
// Appended last, after the markers, so nothing drawn earlier survives underneath: a start or destination
// mark outside the window would otherwise sit on top of the cover and claim the agent could see it.
function scrim(cell: CellKey, radius: number): SVGElement {
  const {row, col} = cellXY(cell);
  const layer = createSvgElement("g", {class: "maze-lens-scrim"});
  for (let r = row - radius; r <= row + radius; r += 1) {
    for (let c = col - radius; c <= col + radius; c += 1) {
      if (Math.abs(r - row) + Math.abs(c - col) <= radius) continue;
      const rect = createSvgElement("rect", {x: c * CELL, y: r * CELL, width: CELL, height: CELL});
      rect.setAttribute("class", "maze-lens-out");
      rect.setAttribute("data-cell", getCellKey({row: r, col: c}));
      layer.append(rect);
    }
  }
  return layer;
}

// buildLens draws the window with the same three functions that draw the grid.
//
// Re-drawn rather than <use>d: our tints are class-driven and the ungraded cells are filled by url(#…),
// and author styles matching into a use shadow tree is not dependable - the lens could come out
// uncoloured. Re-drawing costs a window's worth of nodes, 25 at radius 2, and cannot diverge from the
// grid because it is the same implementation.
function buildLens(
  model: ReplayModel,
  frame: Frame,
  cell: CellKey,
  radius: number,
  showScrim: boolean,
  colorOf: (seat: number) => string,
): SVGElement | null {
  if (!model.maze) return null;

  const svg = createSvgElement("svg", {
    viewBox: lensViewBox(cell, radius),
    class: "maze-lens-grid",
    role: "img",
    "aria-label": `Cells within ${radius} of ${spellCell(cell)}, magnified`
  });

  // The pattern lives in the document that references it, so the lens needs its own copy or the
  // ungraded cells inside it lose their fill.
  svg.append(ungradedHatch());
  drawWalls(svg, model.maze);
  const overlay = createSvgElement("g", {class: "maze-overlay"});
  svg.append(overlay);
  drawFrame(overlay, frame, model, colorOf);
  drawMarkers(svg, model);
  if (showScrim) svg.append(scrim(cell, radius));

  return svg;
}

// drawWalls renders the static maze once. Every edge a cell has no exit through becomes a line, so
// interior walls are drawn twice - once from each side - which costs nothing and avoids having to
// special-case the outer boundary.
function drawWalls(svg: SVGElement, maze: Maze): void {
  const walls = createSvgElement("g", {stroke: "var(--oracle-ink)", "stroke-width": 2, "stroke-linecap": "square"});
  for (const [cell, open] of maze.exits) {
    const {x, y} = cellXY(cell);
    const edges: Record<Move, [number, number, number, number]> = {
      MoveUp: [x, y, x + CELL, y],
      MoveDown: [x, y + CELL, x + CELL, y + CELL],
      MoveLeft: [x, y, x, y + CELL],
      MoveRight: [x + CELL, y, x + CELL, y + CELL]
    };
    for (const [move, [x1, y1, x2, y2]] of Object.entries(edges)) {
      if (isMove(move) && !open.has(move)) {
        walls.append(createSvgElement("line", {x1, y1, x2, y2}));
      }
    }
  }
  svg.append(walls);
}

// drawMarkers draws the fixed points of the round: where it began and where it had to end.
function drawMarkers(svg: SVGElement, model: ReplayModel): void {
  if (model.startCell) {
    const {x, y} = cellXY(model.startCell);
    // Deliberately smaller than the destination square rather than the same mark in another colour.
    // The two sit on the same grid and mean opposite things, and rose against muted is the one pairing
    // a red-green colour deficiency cannot separate - so the size difference, not the fill, is what
    // says which is which. Same reasoning as the rejected-move cross further down this file.
    const inset = 11;
    svg.append(
      createSvgElement("rect", {
        x: x + inset, y: y + inset, width: CELL - inset * 2, height: CELL - inset * 2,
        fill: "var(--oracle-muted)", stroke: "var(--oracle-muted)", "stroke-width": 2
      })
    );
  }

  if (model.destinationCell) {
    const {x, y} = cellXY(model.destinationCell);
    svg.append(
      createSvgElement("rect", {
        x: x + 6, y: y + 6, width: CELL - 12, height: CELL - 12, fill: "var(--oracle-rose)", stroke: "var(--oracle-rose)", "stroke-width": 2
      })
    );
  }
}

// --- The bars beside the scrubber ---

// One bar per turn, sharing the strip's width whatever the turn count - 16 wide bars for a short round,
// slivers across a 464-turn one, which is the right shape for a histogram either way.
//
// Heights are relative to the round's own maximum rather than an absolute scale. The question these
// answer is where within *this* run the agent batched hardest and paid most, and a fixed scale would
// flatten a whole round that never exceeded two moves.
//
// Scaled by square root, not linearly. These distributions are long-tailed: in a real 464-turn round
// 261 turns submitted a single move and exactly one submitted twelve, so a linear scale gave the
// common case 2px of a 24px strip and spent the rest on one outlier. Square root keeps the order
// intact and the outlier tallest while lifting the bulk into view - 1 of 12 becomes 29% instead of 8%.
// Nothing is hidden or clipped, and each bar's title carries its exact figure.
function buildBars(
  strip: HTMLElement,
  values: Array<number | null>,
  height: (value: number) => number,
): HTMLElement[] {
  strip.replaceChildren();

  // Separated into individual bars where there is room for it, and only where there is room.
  //
  // The strip is around 830px wide, so the gap has to be a function of the count rather than a fixed
  // rule: at 16 turns a 2px gap reads as a row of marks, and at 464 turns it would take 463px of the
  // 833 and leave each bar under a pixel - a gap that erases what it is meant to separate. Past that
  // density the honest form is a continuous histogram, which is what a bar under two pixels is anyway.
  strip.style.gap = values.length <= 80 ? "2px" : values.length <= 200 ? "1px" : "0px";
  const bars = values.map((value) => {
    const bar = createHtmlElement("div", "maze-bar");
    if (value === null) {
      // Not a zero. A charge nothing reported is a cost we could not read, and drawing it flat would
      // claim the turn was free.
      bar.classList.add("is-unknown");
      bar.style.height = "100%";
    } else {
      bar.style.height = `${value > 0 ? Math.max(height(value), 6) : 0}%`;
    }
    strip.append(bar);
    return bar;
  });

  return bars;
}

function buildMovesBars(strip: HTMLElement, model: ReplayModel): HTMLElement[] {
  const submitted = model.turns.map((turn) => turn.moves.length);
  const most = Math.max(1, ...submitted);
  const bars = buildBars(strip, submitted, (value) => Math.sqrt(value / most) * 100);

  // The applied share fills from the bottom, so the ungreened remainder is exactly what the agent asked
  // for and did not get.
  for (const [index, bar] of bars.entries()) {
    const turn = model.turns[index];
    if (!turn) continue;
    if (turn.applied === null) {
      bar.classList.add("is-unknown");
      bar.style.setProperty("--applied", "0%");
      bar.title = `Turn ${turn.turn}: applied moves not reported`;
      continue;
    }

    const share = turn.moves.length > 0 ? (turn.applied / turn.moves.length) * 100 : 0;
    bar.style.setProperty("--applied", `${share}%`);
    bar.title = `Turn ${turn.turn}: ${turn.applied} of ${turn.moves.length} applied`;
  }

  strip.hidden = bars.length === 0;
  return bars;
}

// One name per charge, used by the legend, the bar tooltips and the Turns row alike. A reader who
// learns "invalid move" from the legend must meet the same words in the summary table, or the two
// surfaces read as two unrelated tallies that happen to share numbers.
const decayLabel = (charge: number): string => DECAY_REASONS[charge] ?? `${charge} decay`;

function buildDecayBars(strip: HTMLElement, model: ReplayModel): HTMLElement[] {
  const charges = model.turns.map((turn) => turn.decayCharged);

  // A round where nothing reported a charge - an agent that never called get_last_prediction_outcome -
  // gets no strip at all rather than a band of unknowns.
  if (charges.every((charge) => charge === null)) {
    strip.replaceChildren();
    strip.hidden = true;
    return [];
  }

  // Height and colour together: the height is how much it cost, the colour is what it was for.
  //
  // Thirds against Tapoo's own ceiling of three, absolute rather than relative to this round. Scaled to
  // the round, a run that only ever paid the base rate would draw every bar full height - the cheapest
  // possible round rendered as the most expensive one - and a base charge would mean a different height
  // in every report. Linear rather than square root: with three steps there is no tail to compress, and
  // thirds are what the reader is counting.
  const bars = buildBars(strip, charges, (value) => (Math.min(value, MOST_DECAY) / MOST_DECAY) * 100);

  for (const [index, bar] of bars.entries()) {
    const turn = model.turns[index];
    if (!turn) continue;
    const charge = turn.decayCharged;
    if (charge === null) {
      bar.title = `Turn ${turn.turn}: decay not reported`;
      continue;
    }

    // Severity by hue as well as by height, so a penalty is not just a slightly taller mark.
    bar.classList.add(`is-decay-${Math.min(charge, MOST_DECAY)}`);
    const reason = DECAY_REASONS[charge];
    bar.title = `Turn ${turn.turn}: ${charge} decay${reason ? ` - ${reason}` : ""}`;
  }

  strip.hidden = false;
  return bars;
}

// buildDecayLegend names what the strip below the scrubber is charging for, and how often.
//
// Three colours on a two-pixel bar say nothing on their own. The legend gives each one its rule and
// its count for this round, so the strip reads as a tally of what the round cost rather than as
// decoration - and a reader who never hovers a bar still learns the scale.
//
// Only the charges this round actually incurred are listed. A legend naming a penalty that never
// happened describes the rules rather than the run, and the run is what the reader is looking at.
function buildDecayLegend(legend: HTMLElement, frame: Frame, hidden: boolean): void {
  legend.replaceChildren();
  legend.hidden = hidden;
  if (hidden) return;

  // Counted over the turns played, not the whole round: this is a key to the strip above it, and that
  // strip fades everything ahead of the thumb. The round's own totals are already in the level summary's
  // Turns row, which is where a reader goes for the figure that does not move.
  for (const {charge, count} of decayTally(frame.played).counts) {
    const item = createHtmlElement("li", "maze-legend-item");
    item.append(createHtmlElement("span", `maze-legend-swatch is-decay-${charge}`));
    // Split the same way as the visit legend beside the grid: two keys with the same shape should not
    // weight their numbers differently.
    item.append(createHtmlElement("span", null, `${decayLabel(charge)} - `));
    item.append(createHtmlElement("strong", "maze-legend-count", formatCount(count)));
    legend.append(item);
  }

  legend.hidden = legend.childElementCount === 0;
}

// VISIT_SCALE holds only what distinguishes one grade from the next, in worsening order.
//
// Renders as, in this order - the whole of what a reader sees, so wording can be judged here rather
// than reconstructed from the pieces below:
//
//   Unvisited - cells with no visits yet (open ground)
//   Explored - cells with fewer visits than the open-exit count
//   Backtracking - cells with visits equal to the open-exit count
//   Oscillating - cells with more visits than the open-exit count
//
// The name and the "cells with" stem are composed at render rather than retyped four times. That is not
// only less to read: the name shown is the status itself, so it cannot drift from the value it
// explains. A row relabelled "Revisiting" while its swatch stayed is-oscillating was one typo away and
// would have been invisible; the legend test now checks each label against the swatch's own class.
//
// Every claim these four make, in one place, so the next edit does not have to rediscover them:
//
// 1. All four are one comparison at four positions - the cell's total visits against its count of open
//    exits - worded as one scale: none, fewer, equal, more. Read down the key and the whole scale is
//    visible without being explained, which is the reason a reader looks at a key at all. Unvisited
//    joins that construction rather than describing itself: the zero is a position on the same axis.
//
//    "Equal to" in the middle, never "as many as", even though the latter is the tidier parallel with
//    "fewer than" and "more than". "As many as" is idiomatically an upper bound - "as many as fifty
//    attended" means up to fifty - and that reading is precisely the explored case, so the phrase could
//    invert the distinction it exists to draw. This is a report about exact counts: backtracking is
//    visits == open exits, not within one of it, and the wording has to be as unarguable as the rule.
//
// 2. The name is the status verbatim, capitalised. It is the vocabulary of the log and of Tapoo's own
//    tool description, so a reader can carry "oscillating" straight back to the payload.
//
// 3. "Open exits", never bare "exits". A reader looking at a grid of boxes counts four sides per cell,
//    and the denominator is only the sides a move can pass through - a corridor cell has four sides and
//    two open exits, so "two visits" is its whole budget rather than half of it. The word carries the
//    difference between the maze's structure and the walls that shape it.
//
// 4. Both counts are totals, and the wording has to keep saying so. Tapoo tracks no per-exit ledger: a
//    T-junction entered three times through the same exit is backtracking at three and oscillating at
//    four, with two open exits still untouched. So "one visit per exit" is wrong however well it reads
//    - it describes a cell worked evenly, which is not what the status means and not something the log
//    could tell us.
//
// 5. Dead ends need no clause of their own. A dead-end has one open exit, so its first visit already
//    equals that count and it reads as backtracking by the ordinary rule; naming them separately made
//    an exception of what the comparison produces on its own.
const VISIT_SCALE: Array<[VisitStatus, string]> = [
  ["unvisited", "cells with no visits yet (open ground)"],
  ["explored", "cells with fewer visits than the open-exit count"],
  ["backtracking", "cells with visits equal to the open-exit count"],
  ["oscillating", "cells with more visits than the open-exit count"],
];

const visitLabel = (status: VisitStatus, gloss: string): string =>
  `${capitalize(status)} - ${gloss}`;
// buildVisitLegend names the three tints on the grid, and counts them for the frame on screen.
//
// Same argument as the decay legend below it: three colours say nothing on their own, and a reader who
// never hovers a cell still has to learn the scale. Counted per frame rather than per round because the
// legend is a key to what is drawn right now - watching "oscillating - 3" appear as you scrub is the
// finding, not a footnote to it.
//
// unvisited is counted, not tallied: no cell in frame.visited can be unvisited - being there means it
// was entered - so it is simply the maze's area less what has been walked. Listing it completes the
// scale and makes the four counts sum to the maze, which is what turns the key into a tracker.
function buildVisitLegend(legend: HTMLElement, model: ReplayModel, frame: Frame): void {
  legend.replaceChildren();

  const counts = new Map<VisitStatus, number>();
  let ungraded = 0;
  for (const {status} of frame.visited.values()) {
    if (status === null) ungraded += 1;
    else counts.set(status, (counts.get(status) ?? 0) + 1);
  }

  const cells = model.stats?.cells;
  if (typeof cells === "number") {
    // Clamped: a walk that somehow left the grid would otherwise report a negative remainder, and the
    // key is the wrong place for a reader to first meet that.
    counts.set("unvisited", Math.max(0, cells - frame.visited.size));
  }

  for (const [status, gloss] of VISIT_SCALE) {
    const count = counts.get(status);
    // A state the round has not reached is left out rather than shown at zero, as the decay legend does:
    // a legend naming what never happened describes the rules instead of the run.
    if (count === undefined || count === 0) continue;
    const item = createHtmlElement("li", "maze-legend-item");
    item.append(createHtmlElement("span", `maze-legend-swatch is-${status}`));
    // Label and count as separate elements so the number can carry its own weight. The count is the
    // datum here - the label explains it once and then never changes, while the number is what a reader
    // watches move as they scrub.
    item.append(createHtmlElement("span", null, `${visitLabel(status, gloss)} - `));
    item.append(createHtmlElement("strong", "maze-legend-count", formatCount(count)));
    legend.append(item);
  }

  // After the scale, not inside it: this is the absence of a position rather than a position on it.
  // Counted all the same, or the rows stop summing to the maze.
  //
  // Named for what these cells are, not for what the log lacks - "not reported" read like a fault the
  // reader should worry about, when this is simply how the log is shaped. A cell is graded by the
  // payload on the turn *after* the one that entered it, so which cells are waiting depends on where
  // the scrubber is, and one label cannot be true at both ends:
  //
  //   - anywhere before the end, the next turn's payload will grade them. At the very first frame that
  //     is the start square, which no neighbour has pointed back at yet;
  //   - at the last frame there is no next turn. Tapoo stops logging these three tools once a win or
  //     loss is confirmed, so the closing turn's batch is never covered by anything.
  //
  // Saying "closing turn" at frame 0 was simply false, and a reader checking it against the caption -
  // "Start position, before the first turn" - would have caught us in it.
  if (ungraded > 0) {
    const atEnd = frame.totalTurns > 0 && frame.turnIndex === frame.totalTurns;
    const item = createHtmlElement("li", "maze-legend-item");
    item.append(createHtmlElement("span", "maze-legend-swatch is-ungraded"));
    item.append(
      createHtmlElement(
        "span",
        null,
        atEnd
          ? "Closing turn - cells from moves batched on the last turn - "
          : "Awaiting a reading - cells the next turn will grade - ",
      ),
    );
    item.append(createHtmlElement("strong", "maze-legend-count", formatCount(ungraded)));
    legend.append(item);
  }

  legend.hidden = legend.childElementCount === 0;
}

// --- The scrubbed frame ---

// drawFrame paints everything that changes as the scrubber moves. Kept in its own group so a repaint
// removes exactly the previous frame and never the walls beneath it.
function drawFrame(overlay: SVGElement, frame: Frame, model: ReplayModel, colorOf: (seat: number) => string): void {
  overlay.replaceChildren();

  // Visited cells are tinted by how heavily Tapoo says they were worked, not by whether they were
  // entered at all. One flat tint said a run that ended thrashing in a corner looked exactly like a
  // clean traversal.
  //
  // The tint is never the only cue: the agent-coloured trail drawn below crosses every visited cell by
  // construction, and the legend names the three colours. It is a tint and not a bar along each cell's
  // lower edge, which would carry the same weight and orientation as a wall and read as one - making the
  // maze look like it had walls the log never described.
  for (const [cell, {status}] of frame.visited) {
    const {x, y} = cellXY(cell);
    const rect = createSvgElement("rect", {
      x: x + 1, y: y + 1, width: CELL - 2, height: CELL - 2
    });
    // A class rather than an inline fill, so the ramp lives with the rest of the palette and can be
    // reasoned about as one scale instead of a constant buried in a draw call.
    // is-ungraded, not a status: the log never graded this cell, and the hatch says so rather than
    // borrowing the mildest colour on the scale.
    rect.setAttribute("class", `maze-cell ${status === null ? "is-ungraded" : `is-${status}`}`);
    // The pattern is referenced by url(), which a stylesheet cannot express as cleanly as the flat
    // tints - so this one fill is set here while the rest of the ramp lives in the palette.
    if (status === null) rect.setAttribute("fill", `url(#${UNGRADED_PATTERN})`);
    overlay.append(rect);
  }

  // The path walked so far, per seat, so crossing trails stay tellable apart. Grouped by the seat rather
  // than by the name for the reason agentIndexOf gives: two seats that named no player are two seats.
  const bySeat = new Map<number, CellKey[]>();
  for (const turn of frame.played) {
    const seat = agentIndexOf(model.agents, turn);
    if (!bySeat.has(seat)) bySeat.set(seat, []);
    bySeat.get(seat)?.push(...turn.cells);
  }
  for (const [seat, cells] of bySeat) {
    if (cells.length < 2) continue;
    const points = cells.map((cell) => {
      const {x, y} = cellXY(cell);
      return `${x + CELL / 2},${y + CELL / 2}`;
    });
    overlay.append(
      createSvgElement("polyline", {
        points: points.join(" "), fill: "none", stroke: colorOf(seat),
        "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.9
      })
    );
  }


  for (const [seat, cell] of frame.positions) {
    const {x, y} = cellXY(cell);
    overlay.append(
      createSvgElement("circle", {
        cx: x + CELL / 2, cy: y + CELL / 2, r: 7,
        fill: colorOf(seat), stroke: "var(--oracle-paper)", "stroke-width": 2
      })
    );
  }
}

// turnNarrative is the scrubber's spoken label and its caption, so what the grid shows is also stated in
// words - a colour-coded path is not readable to everyone looking at it.
// turnNarrative names the frame you are on, in the little the bars cannot carry.
//
// Not the whole turn: who acted, how many moves landed and what was refused are the bar strips' job,
// across the whole round rather than one sentence about one turn. What is left is what a bar cannot say -
// which turn this is, and which move hit a wall.
//
// The agent is named only in a round that has more than one. On a single-agent round it was the same
// word on every frame, and the trail colour already identifies seats.
function turnNarrative(frame: Frame, model: ReplayModel): string {
  const turn = frame.turn;
  // A frame at turn 0 has no turn to narrate; the two conditions are the same fact, but only the
  // second one tells the checker so.
  if (frame.turnIndex === 0 || !turn) return "Start position, before the first turn.";

  const parts = [`Turn ${turn.turn}`];
  // A seat that stated no player is still named, by the one thing known about it - falling silent would
  // leave two seats' frames reading identically.
  const seat = model.agents[agentIndexOf(model.agents, turn)];
  if (model.agents.length > 1 && seat) {
    parts.push(seat.name === "" ? `Seat ${seat.seatId ?? "?"}` : seat.name);
  }
  parts.push(
    turn.applied === null
      ? `${turn.moves.length} submitted, applied unrecorded`
      : `${turn.applied} of ${turn.moves.length} applied`,
  );
  if (turn.rejectedMove) parts.push(`${turn.rejectedMove} refused`);

  return parts.join(" \u00b7 ");
}

// --- Summaries ---

// linkedLabel builds a labelled anchor for summary rows whose field names describe a mathematical
// concept. The link opens in a new tab so it does not navigate away from the report.
function linkedLabel(text: string, href: string): HTMLElement {
  const a = document.createElement("a");
  a.textContent = text;
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// MAZE_SUMMARY_LINKS maps the stable field keys returned by mazeStructureRows to linked labels, for the
// rows whose names describe a mathematical concept worth linking to.
const MAZE_SUMMARY_LINKS: Record<string, HTMLElement> = {
  "Acyclic graph proof": linkedLabel(
    "Acyclic graph proof",
    "https://en.wikipedia.org/wiki/Tree_(graph_theory)#Equivalent_definitions",
  ),
  "Handshaking lemma proof": linkedLabel(
    "Handshaking lemma proof",
    "https://en.wikipedia.org/wiki/Handshaking_lemma",
  ),
};

// summaryPanel wraps a field/value table in a labelled container, giving each panel a clear heading
// so the Maze and PlayedRound panels are visually distinct but structurally consistent.
function summaryPanel(heading: string, rows: SummaryRow[]): HTMLElement {
  const panel = createHtmlElement("div", "maze-summary-panel");
  panel.append(
    createHtmlElement("h3", "maze-summary-heading", heading),
    summaryTable(rows, ["Property", "Value"]),
  );
  return panel;
}

// turnRow renders the Turns row as the same partition the strip under the scrubber draws: the total,
// then one swatched count per charge, in the strip's own colours.
//
// The swatch is what unifies the two. Numbers alone would leave the reader to guess which of 371, 93
// and 9 the tall dark bars were; sharing `is-decay-N` means the colour they learned from the legend is
// the colour they read here. Each count carries its rule as a title and as visually-hidden text, so
// the meaning survives both a hover and a screen reader that sees no colour at all.
function turnRow(model: ReplayModel): Node {
  const cell = createHtmlElement("span", "maze-turns-cell");
  cell.append(createHtmlElement("span", "maze-turns-total", formatCount(model.turns.length)));

  const tally = decayTally(model.turns);
  const parts: Array<{className: string; count: number; label: string}> = tally.counts.map(
    ({charge, count}) => ({className: `maze-turns-part is-decay-${charge}`, count, label: decayLabel(charge)}),
  );
  // Turns no reading covered are shown, not folded into a charge they may not have paid. Without them
  // the parts would not sum to the total and the row would quietly lose turns.
  if (tally.unreported > 0) {
    parts.push({className: "maze-turns-part is-decay-unreported", count: tally.unreported, label: "decay not reported"});
  }

  // A single part is the whole total restated. Nothing to break down, so the row stays just the count.
  if (parts.length < 2) return cell;

  // The enclosing brackets are drawn by .maze-turns-breakdown's ::before/::after rather than appended
  // here, for the same reason as the separators: in the markup they would be read aloud as "left
  // parenthesis" and would land in the copied text between a count and its label.
  const breakdown = createHtmlElement("span", "maze-turns-breakdown");
  for (const part of parts) {
    const item = createHtmlElement("span", part.className);
    item.title = part.label;
    item.append(createHtmlElement("span", "maze-turns-swatch"));
    item.append(createHtmlElement("span", "maze-turns-count", formatCount(part.count)));
    item.append(createHtmlElement("span", "visually-hidden", ` ${part.label}`));
    breakdown.append(item);
  }
  cell.append(breakdown);
  return cell;
}

function summaryTable(rows: Array<Record<string, string | number | Node>>, headers: string[]): HTMLElement {
  const table = createHtmlElement("table", "maze-summary-table");
  const head = createHtmlElement("thead");
  const headRow = createHtmlElement("tr");
  for (const header of headers) headRow.append(createHtmlElement("th", null, header));
  head.append(headRow);
  table.append(head);

  const body = createHtmlElement("tbody");
  for (const row of rows) {
    const tr = createHtmlElement("tr");
    const entries = Object.entries(row);
    for (const [key, value] of entries) {
      const td = createHtmlElement("td");
      const linked = key === "field" && typeof value === "string" ? MAZE_SUMMARY_LINKS[value] : undefined;
      td.append(linked ?? (value instanceof Node ? value : String(value)));
      tr.append(td);
    }
    body.append(tr);
  }
  table.append(body);
  return table;
}

// agentStatsRow builds a vertical stack of per-agent cards. Each card spans the full panel width so
// five active seats are as legible as one: the card never shrinks to fit beside its neighbours.
// Within the card, metrics are presented as a single-row horizontal table — column headers on top,
// values below — so the label and its value share a column rather than a row.
//
// The numbers arrive already gathered on ReplayModel.agents, one record per seat - so a card reads one
// object, rather than several lists where only a shared index keeps a speed beside the seat that ran it.
// Formatting stays here because "18 of 24 (75%)" needs the maze's cell count, which is this view's.
function agentStatsRow(model: ReplayModel): HTMLElement {
  const container = createHtmlElement("div", "maze-agent-stats");
  const cells = model.stats?.cells ?? 0;

  const metrics: Array<{label: string; read: (agent: AgentSummary) => string}> = [
    // "Unique", not "new" and not bare "cells entered". The value counts each cell once however often
    // the agent went back to it, and this report is largely about how often they did - a label reading
    // "cells entered" beside an oscillating count would invite the two to be compared as if they
    // measured the same thing. "Unique" is also the log's own word: playerUniqueCellsVisited.
    {
      label: "Unique cells",
      read: (agent) =>
        agent.uniqueCells === null || cells === 0
          ? "not recorded"
          : `${formatCount(agent.uniqueCells)} of ${formatCount(cells)} (${Math.round((agent.uniqueCells / cells) * 100)}%)`,
    },
    {
      label: "Decay units charged",
      read: (agent) => (agent.decayCharged === null ? "not recorded" : formatCount(agent.decayCharged)),
    },
    {
      label: "Traversal speed",
      read: (agent) =>
        agent.traversalSpeed === null
          ? "not recorded"
          : `${classifyTraversalSpeed(agent.traversalSpeed)} (${agent.traversalSpeed.toFixed(4)})`,
    },
  ];

  model.agents.forEach((agent, i) => {
    const panel = createHtmlElement("div", "maze-agent-panel");
    panel.append(createHtmlElement("p", "maze-agent-name", agentSeatLabel(agent, i)));

    const table = createHtmlElement("table", "maze-summary-table maze-agent-table");
    const head = createHtmlElement("thead");
    const headRow = createHtmlElement("tr");
    const body = createHtmlElement("tbody");
    const bodyRow = createHtmlElement("tr");

    for (const {label, read} of metrics) {
      headRow.append(createHtmlElement("th", null, label));
      bodyRow.append(createHtmlElement("td", null, read(agent)));
    }

    head.append(headRow);
    body.append(bodyRow);
    table.append(head, body);
    panel.append(table);
    container.append(panel);
  });

  return container;
}
