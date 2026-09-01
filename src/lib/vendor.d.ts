// Ambient declarations for the two Observable packages that ship no types.
//
// Neither `htl` nor `@observablehq/inputs` has a `types` field or a bundled `.d.ts`, and htl is a
// devDependency on purpose - on the page these arrive from Observable's stdlib, not from npm. The
// modules never import them; they take a `ui` object instead (see `ReportUi` in types.ts). Only the
// suites reach for the real packages, deliberately, so the DOM they assert against is the DOM that
// ships.
//
// So this declares the narrow surface those suites use rather than attempting to type the libraries.
// A declaration claiming more than we exercise would be a guess presented as a contract.
//
// The shapes are written out rather than imported from ./types: a relative import inside an ambient
// `declare module` resolves inconsistently across tools - tsc accepted it while the ESLint project
// service read it as an error type, and every Inputs.table call became an unchecked `any`.

declare module "htl" {
  export const html: (strings: TemplateStringsArray, ...values: unknown[]) => Element;
}

declare module "@observablehq/inputs" {
  export const table: (rows: unknown[], options?: Record<string, unknown>) => HTMLElement;
}
