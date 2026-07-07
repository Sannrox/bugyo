// Pure budget-cap helpers, mirroring the Rust `config::budget_status` /
// `effective_cap` logic so the UI can flag near/over-cap sessions.

import type { BudgetConfig } from "./bindings";

export type BudgetLevel = "ok" | "near" | "over";

/** Fraction of the cap at which a session is flagged "near" (matches Rust). */
export const BUDGET_NEAR_FRACTION = 0.9;

/** Classify `spent` against an optional `cap`. No cap (or ≤ 0) → always "ok". */
export function budgetLevel(spent: number, cap: number | null): BudgetLevel {
  if (cap == null || cap <= 0) return "ok";
  if (spent >= cap) return "over";
  if (spent >= cap * BUDGET_NEAR_FRACTION) return "near";
  return "ok";
}

/** The cap in effect for a repo: its project override if set, else the default. */
export function effectiveCap(
  config: BudgetConfig,
  repoRoot: string | null,
): number | null {
  if (repoRoot) {
    const pc = config.projectCaps.find((p) => p.path === repoRoot);
    if (pc) return pc.cap;
  }
  return config.sessionCap;
}
