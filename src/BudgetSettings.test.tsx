import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BudgetSettings from "./BudgetSettings";
import { useBudget } from "./lib/budgetStore";
import { useFleet } from "./lib/fleetStore";

vi.mock("./lib/ipc", () => ({
  budgetGet: vi.fn(async () => ({ sessionCap: null, projectCaps: [] })),
  budgetSet: vi.fn(async () => {}),
  confirmDialog: vi.fn(async () => true),
  messageDialog: vi.fn(async () => {}),
}));

describe("BudgetSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBudget.setState({ config: { sessionCap: null, projectCaps: [] } });
    useFleet.setState({
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

  it("uses registered projects and persists a valid override", async () => {
    render(<BudgetSettings />);
    await waitFor(() =>
      expect(screen.getByLabelText("project path")).toHaveValue(""),
    );

    fireEvent.change(screen.getByLabelText("project path"), {
      target: { value: "/repo" },
    });
    fireEvent.change(screen.getByLabelText("project cap"), {
      target: { value: "12.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: /add project cap/i }));

    const { budgetSet } = await import("./lib/ipc");
    await waitFor(() =>
      expect(budgetSet).toHaveBeenCalledWith({
        sessionCap: null,
        projectCaps: [{ path: "/repo", cap: 12.5 }],
      }),
    );
  });

  it("explains invalid caps instead of silently doing nothing", () => {
    render(<BudgetSettings />);
    fireEvent.change(screen.getByLabelText("project path"), {
      target: { value: "/repo" },
    });
    fireEvent.change(screen.getByLabelText("project cap"), {
      target: { value: "0" },
    });

    expect(
      screen.getByText(/enter a positive credit cap/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /add project cap/i }),
    ).toBeDisabled();
  });

  it("does not turn an invalid session cap into unlimited", async () => {
    render(<BudgetSettings />);
    const input = screen.getByLabelText("session cap");
    fireEvent.change(input, { target: { value: "-4" } });
    fireEvent.blur(input);

    expect(screen.getByText(/positive credit cap.*blank/i)).toBeInTheDocument();
    const { budgetSet } = await import("./lib/ipc");
    expect(budgetSet).not.toHaveBeenCalled();
  });
});
