import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import Plugins from "./Plugins";
import { useFleet } from "./lib/fleetStore";

describe("Plugins", () => {
  beforeEach(() => {
    useFleet.setState({ sessions: {}, order: [], activeId: null });
  });

  it("shows the capability groups in the Codex workspace", () => {
    render(<Plugins />);

    expect(screen.getByRole("heading", { name: "Plugins" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Tools" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "MCP servers" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Agents" })).toBeVisible();
    expect(screen.getAllByText("No capabilities reported yet.")).toHaveLength(
      3,
    );
  });
});
