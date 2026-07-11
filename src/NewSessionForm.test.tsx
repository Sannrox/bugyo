import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewSessionForm from "./NewSessionForm";
import { useFleet } from "./lib/fleetStore";

vi.mock("./lib/ipc", () => ({
  acpStartSession: vi.fn(async () => "plain-1"),
  workspaceCreate: vi.fn(
    async (params: { task: string; repoRoot: string }) => ({
      sessionId: "workspace-1",
      workspace: {
        task: params.task,
        repoRoot: params.repoRoot,
        baseBranch: "main",
        branch: "improve-onboarding",
        worktreePath: "/worktrees/improve-onboarding",
      },
    }),
  ),
  messageDialog: vi.fn(async () => {}),
  pickDirectory: vi.fn(async () => null),
  projectAdd: vi.fn(),
  trustProfileEffectiveTools: vi.fn(async () => []),
  trustProfileList: vi.fn(async () => []),
}));

describe("NewSessionForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFleet.setState({
      sessions: {},
      order: [],
      activeId: null,
      secondaryId: null,
      panel: null,
      projects: [
        {
          path: "/repo",
          name: "repo",
          isGitRepo: true,
          baseBranch: "main",
          setupScript: "",
          checkScript: "",
        },
      ],
    });
  });

  it("defaults to the safe workspace flow and requires a project and task", async () => {
    render(<NewSessionForm />);

    expect(
      screen.getByRole("button", { name: /isolated workspace/i }),
    ).toHaveAttribute("aria-pressed", "true");
    const create = screen.getByRole("button", { name: /create workspace/i });
    expect(create).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByLabelText("project")).toHaveValue("/repo"),
    );

    fireEvent.change(screen.getByLabelText("task"), {
      target: { value: "Improve onboarding" },
    });
    expect(create).toBeEnabled();
    fireEvent.click(create);

    const { workspaceCreate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(workspaceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          repoRoot: "/repo",
          task: "Improve onboarding",
          trustAll: false,
        }),
      ),
    );
    expect(useFleet.getState().activeId).toBe("workspace-1");
  });

  it("prevents duplicate workspace creation before the disabled state paints", async () => {
    const { workspaceCreate } = await import("./lib/ipc");
    let resolveCreate!: (
      value: Awaited<ReturnType<typeof workspaceCreate>>,
    ) => void;
    vi.mocked(workspaceCreate).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    render(<NewSessionForm />);
    await waitFor(() =>
      expect(screen.getByLabelText("project")).toHaveValue("/repo"),
    );
    fireEvent.change(screen.getByLabelText("task"), {
      target: { value: "Create only once" },
    });
    const form = screen
      .getByRole("button", { name: /create workspace/i })
      .closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(workspaceCreate).toHaveBeenCalledTimes(1);

    resolveCreate({
      sessionId: "workspace-1",
      workspace: {
        task: "Create only once",
        repoRoot: "/repo",
        baseBranch: "main",
        branch: "create-only-once",
        worktreePath: "/worktrees/create-only-once",
      },
    });
    await waitFor(() =>
      expect(useFleet.getState().activeId).toBe("workspace-1"),
    );
  });

  it("reuses the selected project's durable workspace defaults", async () => {
    useFleet.setState({
      projects: [
        {
          path: "/repo",
          name: "repo",
          isGitRepo: true,
          baseBranch: "develop",
          setupScript: "bun install",
          checkScript: "bun run test",
        },
      ],
    });
    render(<NewSessionForm />);

    fireEvent.change(screen.getByLabelText("project"), {
      target: { value: "/repo" },
    });
    fireEvent.click(screen.getByText("Advanced"));
    expect(screen.getByLabelText("base branch")).toHaveValue("develop");
    expect(screen.getByLabelText("setup script")).toHaveValue("bun install");

    fireEvent.change(screen.getByLabelText("task"), {
      target: { value: "Use defaults" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create workspace/i }));

    const { workspaceCreate } = await import("./lib/ipc");
    await waitFor(() =>
      expect(workspaceCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          baseBranch: "develop",
          setupScript: "bun install",
        }),
      ),
    );
  });

  it("only starts an unisolated session after the user selects plain mode", async () => {
    render(<NewSessionForm />);

    fireEvent.click(screen.getByRole("button", { name: /plain session/i }));
    expect(screen.queryByLabelText("task")).toBeNull();
    expect(screen.getByText(/do not create a worktree/i)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /start plain session/i }),
    );
    const { acpStartSession } = await import("./lib/ipc");
    await waitFor(() =>
      expect(acpStartSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: undefined, trustAll: false }),
      ),
    );
  });

  it("only offers scoped trust and preserves destructive approvals", () => {
    render(<NewSessionForm />);
    fireEvent.click(screen.getByText("Advanced"));

    expect(screen.queryByText(/^trust all tools$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/always ask for approval/i)).toBeInTheDocument();
  });
});
