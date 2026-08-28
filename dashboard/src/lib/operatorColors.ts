/**
 * One palette for MNO colour, used everywhere an operator is named.
 *
 * Colour is only useful here if it means the same thing on every page:
 * if the overview chart paints Vodacom dark red, the per-operator tiles
 * on /reports and the MNO pills in the filter bar must agree, or the
 * reader has to re-learn the mapping each time they move. This module
 * exists so there is exactly one place that decides.
 *
 * The `fill` classes are Tailwind literals on purpose — the JIT only
 * emits classes it can see written out, so these must never be built by
 * string interpolation.
 *
 * Both markets live in the same map. Tanzania uses vodacom/airtel/tigo/
 * halotel and Mozambique uses vodacom/movitel, but keeping one table
 * means the two dashboards stay literally the same file, and an
 * operator added to either database renders sensibly before anyone
 * touches this code — see the neutral fallback below.
 */
export interface OperatorColor {
  /** Solid background — chart bars, swatches, dots. */
  fill: string;
  /** Foreground for the operator's own name. Contrast-checked on both themes. */
  text: string;
}

const NEUTRAL: OperatorColor = {
  fill: "bg-slate-400",
  text: "text-slate-600 dark:text-slate-300",
};

export const OPERATOR_COLORS: Record<string, OperatorColor> = {
  // Tanzania
  vodacom: { fill: "bg-red-700",    text: "text-red-700 dark:text-red-400" },
  airtel:  { fill: "bg-red-400",    text: "text-red-500 dark:text-red-300" },
  tigo:    { fill: "bg-blue-500",   text: "text-blue-600 dark:text-blue-400" },
  halotel: { fill: "bg-orange-500", text: "text-orange-600 dark:text-orange-400" },
  // Mozambique
  movitel: { fill: "bg-green-600",  text: "text-green-700 dark:text-green-400" },
};

/**
 * Colour for an operator key, falling back to neutral slate.
 *
 * The fallback is the point: operators come from a database table an
 * admin can add rows to, so an unknown name must render as a plain grey
 * chip rather than crashing or rendering colourless-but-broken.
 */
export function operatorColor(name: string | null | undefined): OperatorColor {
  if (!name) return NEUTRAL;
  return OPERATOR_COLORS[name.toLowerCase()] ?? NEUTRAL;
}
