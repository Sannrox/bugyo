import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useFleet } from "./lib/fleetStore";
import StatusBar from "./StatusBar";

function reset() {
  useFleet.setState({
    sessions: {},
    order: [],
    activeId: null,
    secondaryId: null,
    panel: null,
  });
}

describe("StatusBar", () => {
  beforeEach(reset);

  it("renders nothing when there are no sessions", () => {
    const { container } = render(<StatusBar />);
    expect(container).toBeEmptyDOMElement();
  });

  it("summarises status counts and total credits", () => {
    const { addSession, applyEvent } = useFleet.getState();
    addSession({ sessionId: "a" });
    addSession({ sessionId: "b" });
    addSession({ sessionId: "c" });
    applyEvent({ type: "status", sessionId: "a", status: "working" });
    applyEvent({ type: "status", sessionId: "b", status: "needsApproval" });
    applyEvent({
      type: "metrics",
      sessionId: "a",
      contextPercent: null,
      credits: 1.5,
      turnDurationMs: null,
    });

    render(<StatusBar />);
    const bar = screen.getByLabelText("fleet status");
    expect(bar).toHaveTextContent("1 working");
    expect(bar).toHaveTextContent("1 idle"); // c
    expect(bar).toHaveTextContent("1 needs approval");
    expect(bar).toHaveTextContent("1.50 cr");
  });

  it("opens the inbox when the needs-approval count is clicked", () => {
    const { addSession, applyEvent } = useFleet.getState();
    addSession({ sessionId: "a" });
    applyEvent({ type: "status", sessionId: "a", status: "needsApproval" });

    render(<StatusBar />);
    fireEvent.click(screen.getByRole("button", { name: /needs approval/i }));
    expect(useFleet.getState().panel).toBe("inbox");
  });

  it("does not report a stopped agent as idle", () => {
    useFleet.getState().addSession({ sessionId: "cold", connected: false });

    render(<StatusBar />);
    const bar = screen.getByLabelText("fleet status");
    expect(bar).toHaveTextContent("1 stopped");
    expect(bar).toHaveTextContent("0 idle");
  });
});
