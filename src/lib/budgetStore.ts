import { create } from "zustand";
import type { BudgetConfig } from "./bindings";

interface BudgetStore {
  config: BudgetConfig;
  setConfig: (config: BudgetConfig) => void;
}

/** Holds the loaded budget config so components can flag near/over-cap sessions. */
export const useBudget = create<BudgetStore>((set) => ({
  config: { sessionCap: null, projectCaps: [] },
  setConfig: (config) => set({ config }),
}));
