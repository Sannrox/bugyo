import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import QueuePanel from "./QueuePanel";

vi.mock("./lib/ipc", () => ({
  orchQueue: vi.fn(async () => ["first task", "second task"]),
  orchQueueReplace: vi.fn(async () => {}),
}));

describe("QueuePanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("locks editing until the durable queue has loaded", async () => {
    const { orchQueue } = await import("./lib/ipc");
    let resolveQueue!: (value: string[]) => void;
    vi.mocked(orchQueue).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveQueue = resolve;
      }),
    );
    render(<QueuePanel sessionId="s1" onSaved={vi.fn()} />);

    expect(screen.getByText(/loading queued work/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(screen.queryByText(/nothing is queued/i)).not.toBeInTheDocument();

    resolveQueue(["loaded task"]);
    expect(await screen.findByDisplayValue("loaded task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeEnabled();
  });

  it("keeps editing locked after a load failure and supports retry", async () => {
    const { orchQueue } = await import("./lib/ipc");
    vi.mocked(orchQueue).mockRejectedValueOnce(new Error("queue unavailable"));
    render(<QueuePanel sessionId="s1" onSaved={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /queue unavailable/i,
    );
    expect(screen.getByRole("button", { name: /^add$/i })).toBeDisabled();
    expect(screen.queryByText(/nothing is queued/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /retry loading/i }));
    expect(await screen.findByDisplayValue("first task")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^add$/i })).toBeEnabled();
  });

  it("reorders, edits, removes, and saves the durable queue", async () => {
    const onSaved = vi.fn();
    render(<QueuePanel sessionId="s1" onSaved={onSaved} />);
    await screen.findByDisplayValue("first task");

    fireEvent.click(
      screen.getByRole("button", { name: "move queued task 2 up" }),
    );
    fireEvent.change(screen.getByLabelText("queued task 1"), {
      target: { value: "second task updated" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "remove queued task 2" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/unsaved/i);
    fireEvent.click(screen.getByRole("button", { name: "Save now" }));

    const { orchQueueReplace } = await import("./lib/ipc");
    await waitFor(() =>
      expect(orchQueueReplace).toHaveBeenCalledWith("s1", [
        "second task updated",
      ]),
    );
    expect(onSaved).toHaveBeenCalledWith(1);
    expect(screen.getByRole("status")).toHaveTextContent(/saved/i);
  });

  it("flushes outstanding edits when the user navigates away", async () => {
    const { unmount } = render(<QueuePanel sessionId="s1" onSaved={vi.fn()} />);
    await screen.findByDisplayValue("first task");
    fireEvent.change(screen.getByLabelText("queued task 1"), {
      target: { value: "leave safely" },
    });

    unmount();

    const { orchQueueReplace } = await import("./lib/ipc");
    await waitFor(() =>
      expect(orchQueueReplace).toHaveBeenCalledWith("s1", [
        "leave safely",
        "second task",
      ]),
    );
  });
});
