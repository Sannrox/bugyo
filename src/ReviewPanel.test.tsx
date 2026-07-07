import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("./lib/ipc", () => ({
  confirmDialog: vi.fn(async () => true),
  workspaceCheck: vi.fn(async () => ({
    success: true,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
  })),
  workspaceDiff: vi.fn(async () => ""),
  workspaceMerge: vi.fn(async () => {}),
  workspaceMergePreview: vi.fn(),
  workspaceOpenPr: vi.fn(async () => ""),
}));

import ReviewPanel from "./ReviewPanel";
import { workspaceMergePreview, workspaceMerge } from "./lib/ipc";

function openPanel() {
  fireEvent.click(screen.getByText(/review & merge/i));
}

describe("ReviewPanel — conflict dry-run", () => {
  beforeEach(() => vi.clearAllMocks());

  it("warns about predicted conflicts and blocks merge", async () => {
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: false,
      conflictedFiles: ["src/main.rs", "README.md"],
    });

    render(<ReviewPanel sessionId="s1" />);
    openPanel();

    // Preview runs on open → conflict warning appears with the file list.
    await screen.findByText(/merge conflict predicted/i);
    expect(screen.getByText("src/main.rs")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();

    // Even after checks pass, Merge stays disabled while conflicts remain.
    fireEvent.change(screen.getByLabelText("check script"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run checks/i }));
    await screen.findByText(/checks passed/i);

    expect(screen.getByRole("button", { name: /^merge$/i })).toBeDisabled();
    expect(workspaceMerge).not.toHaveBeenCalled();
  });

  it("reports a clean merge and allows merging after checks pass", async () => {
    vi.mocked(workspaceMergePreview).mockResolvedValue({
      clean: true,
      conflictedFiles: [],
    });

    render(<ReviewPanel sessionId="s1" />);
    openPanel();
    await screen.findByText(/merges cleanly/i);

    fireEvent.change(screen.getByLabelText("check script"), {
      target: { value: "true" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run checks/i }));
    await screen.findByText(/checks passed/i);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^merge$/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^merge$/i }));
    await waitFor(() => expect(workspaceMerge).toHaveBeenCalledWith("s1"));
  });
});
