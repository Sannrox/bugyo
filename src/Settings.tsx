import { Settings as SettingsIcon } from "lucide-react";
import { useState } from "react";
import { useSettings, type ToolDisplay } from "./lib/settingsStore";
import TrustProfiles from "./TrustProfiles";
import BudgetSettings from "./BudgetSettings";
import ProjectDefaults from "./ProjectDefaults";
import {
  checkForUpdate,
  installUpdate,
  restartApp,
  type UpdateCheck,
} from "./lib/update";

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
        <h1>Settings</h1>
      </header>
      <p className="muted settings__note">
        Configure how Bugyo presents agent work, prepares projects, governs
        tools, and controls spend. Settings are saved on this device.
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

      <ProjectDefaults />
      <TrustProfiles />
      <BudgetSettings />
      <UpdatesSection />
    </section>
  );
}

/** Manual update check + in-place install (mirrors the auto banner's flow). */
function UpdatesSection() {
  const [state, setState] = useState<
    "idle" | "checking" | "installing" | "installed"
  >("idle");
  const [result, setResult] = useState<UpdateCheck | null>(null);
  const [installError, setInstallError] = useState("");

  const onCheck = async () => {
    setInstallError("");
    setState("checking");
    setResult(await checkForUpdate());
    setState("idle");
  };

  const onInstall = async () => {
    if (result?.status !== "available") return;
    setState("installing");
    setInstallError("");
    try {
      await installUpdate(result.update);
      setState("installed");
    } catch (cause) {
      setInstallError(String(cause));
      setState("idle");
    }
  };

  return (
    <div className="settings__group">
      <div className="settings__row">
        <label className="settings__label">
          <span>Software updates</span>
          <span className="muted">
            {state === "checking"
              ? "Checking for updates…"
              : state === "installing"
                ? "Downloading and installing…"
                : state === "installed"
                  ? "Update installed — restart to apply."
                  : result?.status === "available"
                    ? `Version ${result.info.version} is available.`
                    : result?.status === "uptodate"
                      ? "You're on the latest version."
                      : result?.status === "error"
                        ? `Check failed: ${result.message}`
                        : "Check whether a newer signed release is available."}
          </span>
        </label>
        {state === "installed" ? (
          <button type="button" onClick={() => void restartApp()}>
            Restart now
          </button>
        ) : result?.status === "available" && state === "idle" ? (
          <button type="button" onClick={() => void onInstall()}>
            Install {result.info.version}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void onCheck()}
            disabled={state !== "idle"}
          >
            Check for updates
          </button>
        )}
      </div>
      {installError && (
        <p className="error" role="alert">
          Update installation failed: {installError}
        </p>
      )}
    </div>
  );
}
