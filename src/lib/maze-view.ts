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

import { isMove } from "./log-contract"
import { levelSummaryRows, mazeFrameAt, mazeReplayModel, mazeSummaryRows } from "./maze-model"
import { formatCount } from "./report-adapters"
import type { CellKey, Frame, LevelModel, Maze, Move, Report } from "./types"

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

const cellXY = (cell: CellKey): {row: number; col: number; x: number; y: number} => {
  const [row = 0, col = 0] = cell.split(",").map(Number);
  return {row, col, x: col * CELL, y: row * CELL};
};

// --- Static layers ---

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

// markerFor draws the fixed points of the round: where it began and where it had to end.
function drawMarkers(svg: SVGElement, model: LevelModel): void {
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

function buildMovesBars(strip: HTMLElement, model: LevelModel): HTMLElement[] {
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

// DECAY_REASONS is Tapoo's charging rule, which is an ordinal scale of three and not a measurement.
// Every turn pays a base unit; an invalid move costs two; a response that broke the output format costs
// three.
const DECAY_REASONS: Record<number, string> = {
  1: "base charge",
  2: "invalid move",
  3: "output format violation",
};

// The most a turn can be charged: Tapoo's own ceiling.
//
// Three is charged only when lastSubmittedMoves is empty - a malformed response, an exhausted token
// cap, or a failed request - and those turns are in the replay now, so the strip has all three steps
// to draw and scales to all three. An absolute scale rather than the round's own maximum: a base
// charge means the same height in every report, and a round that only ever paid the base rate reads
// as the cheap run it was instead of filling the strip.
const MOST_DECAY = 3;

function buildDecayBars(strip: HTMLElement, model: LevelModel): HTMLElement[] {
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
function buildDecayLegend(legend: HTMLElement, model: LevelModel, hidden: boolean): void {
  legend.replaceChildren();
  legend.hidden = hidden;
  if (hidden) return;

  const counts = new Map<number, number>();
  for (const turn of model.turns) {
    if (turn.decayCharged === null) continue;
    const charge = Math.min(turn.decayCharged, MOST_DECAY);
    counts.set(charge, (counts.get(charge) ?? 0) + 1);
  }

  for (const charge of [1, 2, 3]) {
    const count = counts.get(charge);
    if (count === undefined) continue;

    const item = createHtmlElement("li", "maze-legend-item");
    item.append(createHtmlElement("span", `maze-legend-swatch is-decay-${charge}`));
    item.append(
      createHtmlElement("span", null, `${DECAY_REASONS[charge] ?? `${charge} decay`} - ${formatCount(count)}`),
    );
    legend.append(item);
  }

  legend.hidden = legend.childElementCount === 0;
}

// --- The scrubbed frame ---

// drawFrame paints everything that changes as the scrubber moves. Kept in its own group so a repaint
// removes exactly the previous frame and never the walls beneath it.
function drawFrame(overlay: SVGElement, frame: Frame, colorOf: (name: string) => string): void {
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
        x: x + 1, y: y + 1, width: CELL - 2, height: CELL - 2, fill: "var(--oracle-selected)", opacity: 1.0
      })
    );
  }

  // The path walked so far, per agent, so crossing trails stay tellable apart.
  const byAgent = new Map<string, CellKey[]>();
  for (const turn of frame.played) {
    const name = turn.playerName ?? "";
    if (!byAgent.has(name)) byAgent.set(name, []);
    byAgent.get(name)?.push(...turn.cells);
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
// turnNarrative names the frame you are on, in the little the bars cannot carry.
//
// It used to spell out the whole turn - who acted, every move submitted, how many landed, what was
// refused - which is now the bar strips' job across the entire round rather than one sentence about
// one turn. What is left is what a bar cannot say: which turn this is, and which move hit a wall.
//
// The agent is named only in a round that has more than one. On a single-agent round it was the same
// word on every frame, and the trail colour already identifies seats.
function turnNarrative(frame: Frame, model: LevelModel): string {
  const turn = frame.turn;
  // A frame at turn 0 has no turn to narrate; the two conditions are the same fact, but only the
  // second one tells the checker so.
  if (frame.turnIndex === 0 || !turn) return "Start position, before the first turn.";

  const parts = [`Turn ${turn.turn}`];
  if (model.agents.length > 1 && turn.playerName) parts.push(turn.playerName);
  parts.push(
    turn.applied === null
      ? `${turn.moves.length} submitted, applied unrecorded`
      : `${turn.applied} of ${turn.moves.length} applied`,
  );
  if (turn.rejectedMove) parts.push(`${turn.rejectedMove} refused`);

  return parts.join(" \u00b7 ");
}

// --- Summaries ---

function summaryTable(rows: Array<Record<string, unknown>>, headers: string[]): HTMLElement {
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
export function createMazeReplay(report: Report): HTMLElement {
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
    const option = createHtmlElement("option", null, model.label) as HTMLOptionElement;
    option.value = String(index);
    select.append(option);
  });
  if (models.length > 1) controls.append(select);
  root.append(controls);

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

  const legend = createHtmlElement("ul", "maze-legend");
  const summary = createHtmlElement("div", "maze-summary");
  root.append(figure, caption, scrubberRow, legend, summary);

  // models is non-empty here: the caller returned early for a report with no rounds.
  let active: LevelModel = models[0]!;

  const colorOf = (name: string): string => {
    const index = active.agents.indexOf(name);
    return AGENT_COLORS[(index < 0 ? 0 : index) % AGENT_COLORS.length] ?? AGENT_COLORS[0]!;
  };

  let overlay: SVGElement | null = null;

  const paint = (): void => {
    const frame = mazeFrameAt(active, Number(range.value));
    if (overlay) drawFrame(overlay, frame, colorOf);
    caption.textContent = turnNarrative(frame, active);
    readout.textContent = `${frame.turnIndex} / ${frame.totalTurns}`;
    range.setAttribute("aria-valuetext", turnNarrative(frame, active));

    // The strips and the slider have to agree about where you are. Toggling classes on kept references
    // is the whole update - the bars themselves do not change as you scrub.
    //
    // The slider fades its track ahead of the thumb; the strips fade the turns ahead of it, so all
    // three read as one control rather than a slider with two decorations beside it.
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

  const showLevel = (model: LevelModel): void => {
    active = model;
    figure.replaceChildren();
    summary.replaceChildren();
    legend.replaceChildren();
    legend.hidden = true;

    if (!model.maze) {
      // A round with no usable maze is reported, not skipped: the profile beside it is still real, and
      // silently dropping the grid would read as "this round had nothing worth showing".
      //
      // Stated as plainly as the warning banner states its own findings. "Maze unavailable" was the
      // heading here, and it read as a temporary condition - something that might load in a moment -
      // rather than as a payload that arrived wrong or never arrived at all. The reader is looking at
      // the space the traversal should occupy, so this is where they learn what is missing from it.
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
    drawMarkers(svg, model);
    figure.append(svg);

    range.min = "0";
    range.max = String(model.turns.length);
    range.value = String(model.turns.length);
    range.setAttribute("aria-label", `Turn to show, 0 to ${model.turns.length}`);

    // Built once per round. drawFrame runs on every scrub and has no business rebuilding 900 nodes.
    movesBars = buildMovesBars(movesStrip, model);
    decayBars = buildDecayBars(decayStrip, model);
    buildDecayLegend(legend, model, decayStrip.hidden === true);

    summary.append(
      summaryTable(mazeSummaryRows(model), ["Maze", "Value"]),
      levelSummary.length > 0
        ? summaryTable(levelSummary, ["Level", "Game", "Outcome", "Turns", "Speed", "Class"])
        : createHtmlElement("div")
    );

    paint();
  };

  range.addEventListener("input", paint);
  select.addEventListener("change", () => {
    const chosen = models[Number((select as HTMLSelectElement).value)];
    if (chosen) showLevel(chosen);
  });

  showLevel(models[0]!);
  return root;
}
