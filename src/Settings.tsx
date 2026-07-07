import { Settings as SettingsIcon } from "lucide-react";
import { useSettings, type ToolDisplay } from "./lib/settingsStore";
import TrustProfiles from "./TrustProfiles";
import BudgetSettings from "./BudgetSettings";

const TOOL_OPTIONS: { value: ToolDisplay; label: string; hint: string }[] = [
  { value: "all", label: "All", hint: "Show every tool call" },
  { value: "edits", label: "Edits only", hint: "Only calls that change files" },
  { value: "hidden", label: "Hidden", hint: "Hide all tool calls" },
];

/** Global display settings: transcript rendering preferences (persisted). */
export default function Settings() {
  const showReasoning = useSettings((s) => s.showReasoning);
  const toolDisplay = useSettings((s) => s.toolDisplay);
  const setShowReasoning = useSettings((s) => s.setShowReasoning);
  const setToolDisplay = useSettings((s) => s.setToolDisplay);

  return (
    <section className="settings" aria-label="settings">
      <header className="settings__head">
        <SettingsIcon size={18} aria-hidden />
        <h2>Settings</h2>
      </header>
      <p className="muted settings__note">
        Display preferences apply to every session and are saved on this device.
      </p>

      <div className="settings__group">
        <div className="settings__row">
          <label htmlFor="set-reasoning" className="settings__label">
            <span>Show reasoning</span>
            <span className="muted">
              Display the agent&apos;s &ldquo;thinking&rdquo; blocks.
            </span>
          </label>
          <input
            id="set-reasoning"
            type="checkbox"
            role="switch"
            aria-label="show reasoning"
            checked={showReasoning}
            onChange={(e) => setShowReasoning(e.currentTarget.checked)}
          />
        </div>

        <div className="settings__row">
          <label htmlFor="set-tools" className="settings__label">
            <span>Tool calls</span>
            <span className="muted">Which tool activity to show inline.</span>
          </label>
          <select
            id="set-tools"
            aria-label="tool calls"
            value={toolDisplay}
            onChange={(e) =>
              setToolDisplay(e.currentTarget.value as ToolDisplay)
            }
          >
            {TOOL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} title={o.hint}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <TrustProfiles />
      <BudgetSettings />
    </section>
  );
}
