import { useLayoutEffect } from "react";
import Sidebar from "./Sidebar";
import SessionPane from "./SessionPane";
import StatusBar from "./StatusBar";
import { useFleet } from "./lib/fleetStore";
import type { WorkspaceReviewState } from "./lib/bindings";
import SearchPanel from "./SearchPanel";
import Plugins from "./Plugins";
import Automations from "./Automations";
import Settings from "./Settings";
import FleetGrid from "./FleetGrid";
import Inbox from "./Inbox";
import Timeline from "./Timeline";
import NewSessionForm from "./NewSessionForm";

const REPO = "/Users/raphael.kuettner/Projects/kiro-app";
const REVIEW: WorkspaceReviewState = {
  stage: "readyToLand",
  hasChanges: true,
  hasUncommittedChanges: false,
  changedFiles: [
    "src/App.tsx",
    "src/App.css",
    "src/Sidebar.tsx",
    "src/SessionPane.tsx",
  ],
  lastCheck: {
    script: "bun run test",
    success: true,
    exitCode: 0,
    completedAt: "2026-07-11T12:00:00.000Z",
    changeFingerprint: "visual",
  },
  pullRequestUrl: null,
};

const DIFF = `diff --git a/src/App.tsx b/src/App.tsx
index 0123456..89abcde 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -4,7 +4,9 @@ function App() {
-  return <Fleet />;
+  return (
+    <CodexShell><Fleet /></CodexShell>
+  );
 }`;

const STRESS_DIFF = `${DIFF}\n${Array.from(
  { length: 80 },
  (_, index) => `+  const scrollCheck${index} = "reachable row ${index}";`,
).join("\n")}`;

/**
 * Development-only, deterministic state used for source-versus-build visual
 * QA. Open `/?visual-reference` while running `bun run tauri dev`.
 */
export default function VisualReferenceFixture() {
  const panel = useFleet((state) => state.panel);
  const visualPage = new URLSearchParams(window.location.search).get(
    "visual-page",
  );
  const stress = new URLSearchParams(window.location.search).has(
    "visual-stress",
  );
  useLayoutEffect(() => {
    const requestedPanel = visualPage;
    const fixturePanel = [
      "search",
      "plugins",
      "automations",
      "settings",
      "fleet",
      "inbox",
      "eventlog",
    ].includes(requestedPanel ?? "")
      ? (requestedPanel as typeof panel)
      : null;
    useFleet.setState({
      sessions: {},
      order: [],
      activeId: null,
      secondaryId: null,
      panel: fixturePanel,
      heartbeat: null,
      projects: [
        {
          path: REPO,
          name: "kiro-app",
          isGitRepo: true,
          baseBranch: "main",
          setupScript: "",
          checkScript: "bun run typecheck && bun run test",
        },
      ],
      errors: [],
    });

    const fleet = useFleet.getState();
    fleet.addSession({
      sessionId: "visual-primary",
      connected: true,
      review: REVIEW,
      workspace: {
        task: "Test",
        repoRoot: REPO,
        baseBranch: "main",
        branch: "test-3",
        worktreePath:
          "/Users/raphael.kuettner/Projects/.bugyo-worktrees/kiro-app/test-3",
      },
    });
    fleet.renameSession("visual-primary", "Redesign app modern UI");
    fleet.setTranscript("visual-primary", [
      { kind: "user", text: "Redesign the app to be more modern" },
      {
        kind: "agent",
        text: "Redesigned the app around a calmer, more focused workspace. The sidebar now keeps projects and sessions easy to scan, the conversation stays readable, and changes open in a dedicated review inspector when you need them.\n\nThe implementation keeps Bugyo's ACP sessions, approvals, queues, and worktree review flow intact.",
      },
      ...(stress
        ? Array.from({ length: 40 }, (_, index) => ({
            kind: index % 2 === 0 ? ("user" as const) : ("agent" as const),
            text: `Scroll stress message ${index + 1}. This entry verifies that older transcript content remains reachable while the composer stays available.`,
          }))
        : []),
    ]);
    if (stress) {
      for (let index = 0; index < 24; index += 1) {
        const sessionId = `visual-stress-${index}`;
        fleet.addSession({
          sessionId,
          workspace: {
            task: `stress-${index}`,
            repoRoot: REPO,
            baseBranch: "main",
            branch: `scroll-check-${index + 1}`,
            worktreePath: `${REPO}/.stress/${index}`,
          },
        });
        fleet.renameSession(sessionId, `Scroll check ${index + 1}`);
        if (index < 12) fleet.togglePin(sessionId);
      }
    }
    fleet.applyEvent({
      type: "metrics",
      sessionId: "visual-primary",
      contextPercent: 4.8,
      credits: 0.35,
      turnDurationMs: 12_000,
    });
    fleet.setActive(visualPage === "new" ? null : "visual-primary");
    if (fixturePanel) useFleet.setState({ panel: fixturePanel });
  }, [stress, visualPage]);

  return (
    <div className="fleet" data-visual-reference="true">
      <Sidebar />
      <main className="fleet__main">
        {visualPage === "new" ? (
          <NewSessionForm />
        ) : panel === "search" ? (
          <SearchPanel />
        ) : panel === "plugins" ? (
          <Plugins />
        ) : panel === "automations" ? (
          <Automations />
        ) : panel === "settings" ? (
          <Settings />
        ) : panel === "fleet" ? (
          <FleetGrid />
        ) : panel === "inbox" ? (
          <Inbox />
        ) : panel === "eventlog" ? (
          <Timeline />
        ) : (
          <SessionPane
            sessionId="visual-primary"
            initialReviewOpen
            reviewFixture={{ review: REVIEW, diff: stress ? STRESS_DIFF : DIFF }}
          />
        )}
        <StatusBar />
      </main>
    </div>
  );
}
