// Durable session-metadata glue: bridges the pure fleet store (pin/name/order)
// to the backend `session_meta_*` commands. Kept out of the store so the store
// stays framework-free and unit-testable without mocking IPC.

import type { SessionMeta } from "./bindings";
import { useFleet } from "./fleetStore";
import { sessionMetaList, sessionMetaSet } from "./ipc";

/** The current durable metadata for a session, derived from store state. */
export function metaOf(sessionId: string): SessionMeta {
  const s = useFleet.getState();
  const sess = s.sessions[sessionId];
  const order = s.order.indexOf(sessionId);
  return {
    sessionId,
    pinned: sess?.pinned ?? false,
    name: sess?.name ?? null,
    order: order >= 0 ? order : null,
  };
}

/** Persist a single session's current metadata (best-effort). */
export async function persistMeta(sessionId: string): Promise<void> {
  await sessionMetaSet(metaOf(sessionId));
}

/**
 * Persist the manual order of every session (each session's `order` = its index
 * in the store's order array). Called after a reorder so neighbours stay
 * consistent, not just the moved session.
 */
export async function persistOrder(): Promise<void> {
  const s = useFleet.getState();
  await Promise.all(s.order.map((id) => sessionMetaSet(metaOf(id))));
}

/** Load persisted metadata from the backend and apply it to the store. */
export async function hydrateSessionMeta(): Promise<void> {
  const metas = await sessionMetaList();
  useFleet.getState().applySessionMeta(metas);
}
