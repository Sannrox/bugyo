import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import Inbox from "./Inbox";
import { useFleet } from "./lib/fleetStore";

vi.mock("./lib/ipc", () => ({
  acpRespondPermission: vi.fn(async () => {}),
}));

function reset() {
  useFleet.setState({
    sessions: {},
    order: [],
    activeId: null,
    secondaryId: null,
    panel: "inbox",
  });
}

function addApproval() {
  const fleet = useFleet.getState();
  fleet.addSession({ sessionId: "s1" });
  fleet.applyEvent({
    type: "permissionRequested",
    sessionId: "s1",
    requestId: "r1",
    toolCallId: "t1",
    title: "Write configuration",
    options: [
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject_once", name: "Deny", kind: "reject_once" },
    ],
  });
  fleet.applyEvent({
    type: "status",
    sessionId: "s1",
    status: "needsApproval",
  });
}

describe("Attention inbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reset();
  });

  it("offers a useful next step when there is nothing to resolve", () => {
    render(<Inbox />);
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open fleet/i }));
    expect(useFleet.getState().panel).toBe("fleet");
  });

  it("includes workspace changes that are waiting for review", () => {
    useFleet.getState().addSession({
      sessionId: "review-1",
      connected: false,
      review: {
        stage: "needsReview",
        hasChanges: true,
        hasUncommittedChanges: false,
        changedFiles: ["src/Inbox.tsx"],
        lastCheck: null,
        checkCurrent: false,
      },
    });

    render(<Inbox />);

    expect(screen.queryByText(/all caught up/i)).not.toBeInTheDocument();
    expect(screen.getByText("Review changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open review" }));
    expect(useFleet.getState().activeId).toBe("review-1");
  });

  it("submits a permission decision only once while the agent resumes", async () => {
    addApproval();
    render(<Inbox />);

    const allow = screen.getByRole("button", { name: "Allow once" });
    fireEvent.click(allow);

    const { acpRespondPermission } = await import("./lib/ipc");
    await waitFor(() =>
      expect(acpRespondPermission).toHaveBeenCalledWith(
        "s1",
        "r1",
        "allow_once",
      ),
    );
    expect(
      screen
        .getAllByRole("button", { name: /allow|deny|sent/i })
        .every((button) => button.hasAttribute("disabled")),
    ).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(/waiting/i);
  });

  it("shows a retryable error when a permission response fails", async () => {
    const { acpRespondPermission } = await import("./lib/ipc");
    vi.mocked(acpRespondPermission).mockRejectedValueOnce(
      new Error("agent disconnected"),
    );
    addApproval();
    render(<Inbox />);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /agent disconnected.*retry/i,
    );
    expect(screen.getByRole("button", { name: "Deny" })).toBeEnabled();
  });
});
