import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ProjectDefaults from "./ProjectDefaults";
import { useFleet } from "./lib/fleetStore";

vi.mock("./lib/ipc", () => ({
  projectUpdate: vi.fn(async (project) => project),
}));

describe("ProjectDefaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("persists setup and check defaults and updates the fleet store", async () => {
    render(<ProjectDefaults />);
    expect(
      screen.getByRole("button", { name: /save defaults/i }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("repo base branch"), {
      target: { value: "develop" },
    });
    fireEvent.change(screen.getByLabelText("repo setup command"), {
      target: { value: "bun install" },
    });
    fireEvent.change(screen.getByLabelText("repo check command"), {
      target: { value: "bun run test" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save defaults/i }));

    const { projectUpdate } = await import("./lib/ipc");
    await waitFor(() => expect(projectUpdate).toHaveBeenCalledOnce());
    expect(useFleet.getState().projects[0]).toEqual(
      expect.objectContaining({
        baseBranch: "develop",
        setupScript: "bun install",
        checkScript: "bun run test",
      }),
    );
    expect(screen.getByRole("button", { name: /saved/i })).toBeDisabled();
  });
});
