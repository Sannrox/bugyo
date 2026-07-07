// Global, app-wide display preferences (persisted to localStorage). These are
// pure view settings — how the transcript is rendered — so they live entirely
// in the frontend rather than round-tripping through the backend.

import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";

/** In-memory fallback when localStorage is unavailable (tests, SSR). */
const memoryStore = new Map<string, string>();
const memoryStorage: StateStorage = {
  getItem: (key) => memoryStore.get(key) ?? null,
  setItem: (key, value) => {
    memoryStore.set(key, value);
  },
  removeItem: (key) => {
    memoryStore.delete(key);
  },
};

function safeStorage(): StateStorage {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    /* access can throw in sandboxed contexts */
  }
  return memoryStorage;
}

/** How tool calls are shown in the transcript. */
export type ToolDisplay =
  | "all" // every tool call
  | "edits" // only calls that touch files (have a diff)
  | "hidden"; // no tool calls

export interface SettingsStore {
  /** Show the agent's reasoning ("thinking") blocks. */
  showReasoning: boolean;
  /** Which tool calls to display. */
  toolDisplay: ToolDisplay;
  /** Whether the left sidebar is collapsed (hidden to a thin rail). */
  sidebarCollapsed: boolean;
  setShowReasoning: (value: boolean) => void;
  setToolDisplay: (value: ToolDisplay) => void;
  toggleSidebar: () => void;
}

export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({
      showReasoning: true,
      toolDisplay: "all",
      sidebarCollapsed: false,
      setShowReasoning: (value) => set({ showReasoning: value }),
      setToolDisplay: (value) => set({ toolDisplay: value }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
    }),
    { name: "bugyo-settings", storage: createJSONStorage(safeStorage) },
  ),
);
