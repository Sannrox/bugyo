import { useEffect, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import type { TrustProfile } from "./lib/bindings";
import {
  confirmDialog,
  messageDialog,
  trustProfileList,
  trustProfileRemove,
  trustProfileSet,
} from "./lib/ipc";

const ALWAYS_ASK = ["execute_bash", "fs_write", "use_aws"];

function parseList(s: string): string[] {
  return s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Manage trust profiles (approval-rule presets). Profiles pre-trust a scoped
 * allowlist of tools at session start; destructive tools always ask regardless
 * (enforced in the backend), so the UI shows that guarantee explicitly.
 */
export default function TrustProfiles() {
  const [profiles, setProfiles] = useState<TrustProfile[]>([]);
  const [name, setName] = useState("");
  const [autoAllow, setAutoAllow] = useState("");
  const [alwaysAsk, setAlwaysAsk] = useState("");
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setProfiles(await trustProfileList());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    const profile: TrustProfile = {
      id: `tp-${Date.now().toString(36)}`,
      name: n,
      autoAllowTools: parseList(autoAllow),
      alwaysAsk: parseList(alwaysAsk),
    };
    try {
      await trustProfileSet(profile);
      setName("");
      setAutoAllow("");
      setAlwaysAsk("");
      await refresh();
    } catch (err) {
      await messageDialog(String(err));
    }
  }

  async function remove(id: string) {
    const p = profiles.find((x) => x.id === id);
    const ok = await confirmDialog(
      `Delete trust profile "${p?.name ?? id}"? This cannot be undone.`,
      "Delete trust profile",
    );
    if (!ok) return;
    try {
      await trustProfileRemove(id);
      await refresh();
    } catch (err) {
      await messageDialog(String(err));
    }
  }

  return (
    <div className="settings__group" aria-label="trust profiles">
      <h3 className="settings__subhead">
        <ShieldCheck size={15} aria-hidden /> Trust profiles
      </h3>
      <p className="muted settings__note">
        Presets that pre-trust a scoped set of tools at session start.
        Destructive tools ({ALWAYS_ASK.join(", ")}) always require approval and
        can never be pre-trusted.
      </p>

      {profiles.length > 0 && (
        <ul className="tp__list">
          {profiles.map((p) => (
            <li key={p.id} className="tp__item">
              <div className="tp__info">
                <span className="tp__name">{p.name}</span>
                <span className="muted tp__tools">
                  {p.autoAllowTools.length
                    ? `auto-allow: ${p.autoAllowTools.join(", ")}`
                    : "no tools pre-trusted"}
                  {p.alwaysAsk.length
                    ? ` · always ask: ${p.alwaysAsk.join(", ")}`
                    : ""}
                </span>
              </div>
              <button
                type="button"
                className="tp__remove"
                aria-label={`delete ${p.name}`}
                onClick={() => void remove(p.id)}
              >
                <Trash2 size={14} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className="tp__form" onSubmit={add}>
        <input
          aria-label="profile name"
          placeholder="Profile name (e.g. Read-only)"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        <input
          aria-label="auto-allow tools"
          placeholder="Auto-allow tools (comma-separated, e.g. fs_read, code)"
          value={autoAllow}
          onChange={(e) => setAutoAllow(e.currentTarget.value)}
        />
        <input
          aria-label="always-ask tools"
          placeholder="Always ask (comma-separated, optional)"
          value={alwaysAsk}
          onChange={(e) => setAlwaysAsk(e.currentTarget.value)}
        />
        <button type="submit" disabled={!name.trim()}>
          Add profile
        </button>
      </form>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
