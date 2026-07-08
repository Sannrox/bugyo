import { useEffect, useState } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  checkForUpdate,
  installUpdate,
  restartApp,
  type AvailableUpdate,
  type UpdateProgress,
} from "./lib/update";

type Phase = "prompt" | "downloading" | "installed" | "error";

/**
 * A non-intrusive banner that appears only when a newer signed release is
 * available. It checks once on mount (silently ignoring failures/offline),
 * lets the user download+install in place, then offers to relaunch. Dismissing
 * hides it until the next launch.
 */
export default function UpdateBanner() {
  const [handle, setHandle] = useState<Update | null>(null);
  const [info, setInfo] = useState<AvailableUpdate | null>(null);
  const [phase, setPhase] = useState<Phase>("prompt");
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    void checkForUpdate().then((res) => {
      if (!active) return;
      if (res.status === "available") {
        setHandle(res.update);
        setInfo(res.info);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (dismissed || !info || !handle) return null;

  const onInstall = async () => {
    setPhase("downloading");
    setError(null);
    try {
      await installUpdate(handle, setProgress);
      setPhase("installed");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Update failed to install");
    }
  };

  const pct =
    progress && progress.contentLength
      ? Math.min(100, Math.round((progress.downloaded / progress.contentLength) * 100))
      : null;

  return (
    <div className="update-banner" role="status" aria-label="app update">
      <Download size={15} aria-hidden className="update-banner__icon" />
      <span className="update-banner__msg">
        {phase === "installed" ? (
          <>Update {info.version} installed — restart to apply.</>
        ) : phase === "downloading" ? (
          <>
            Downloading {info.version}
            {pct !== null ? ` — ${pct}%` : "…"}
          </>
        ) : phase === "error" ? (
          <>Update failed: {error}</>
        ) : (
          <>
            Bugyo {info.version} is available (you have {info.currentVersion}).
          </>
        )}
      </span>

      {phase === "installed" ? (
        <button
          type="button"
          className="update-banner__action"
          onClick={() => void restartApp()}
        >
          <RefreshCw size={13} aria-hidden /> Restart now
        </button>
      ) : phase === "downloading" ? null : (
        <button
          type="button"
          className="update-banner__action"
          onClick={() => void onInstall()}
        >
          {phase === "error" ? "Retry" : "Install update"}
        </button>
      )}

      {phase !== "downloading" && (
        <button
          type="button"
          className="update-banner__dismiss"
          aria-label="dismiss update notice"
          onClick={() => setDismissed(true)}
        >
          <X size={15} aria-hidden />
        </button>
      )}
    </div>
  );
}
