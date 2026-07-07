import { describe, it, expect } from "vitest";
import { budgetLevel, effectiveCap } from "./budget";
import type { BudgetConfig } from "./bindings";

describe("budgetLevel", () => {
  it("is ok when there is no cap", () => {
    expect(budgetLevel(1000, null)).toBe("ok");
    expect(budgetLevel(1000, 0)).toBe("ok");
  });

  it("classifies under / near / over", () => {
    expect(budgetLevel(5, 10)).toBe("ok");
    expect(budgetLevel(8.9, 10)).toBe("ok");
    expect(budgetLevel(9, 10)).toBe("near");
    expect(budgetLevel(9.99, 10)).toBe("near");
    expect(budgetLevel(10, 10)).toBe("over");
    expect(budgetLevel(12, 10)).toBe("over");
  });
});

describe("effectiveCap", () => {
  const config: BudgetConfig = {
    sessionCap: 5,
    projectCaps: [{ path: "/repo1", cap: 20 }],
  };

  it("prefers a project override, else the session cap", () => {
    expect(effectiveCap(config, "/repo1")).toBe(20);
    expect(effectiveCap(config, "/other")).toBe(5);
    expect(effectiveCap(config, null)).toBe(5);
    expect(
      effectiveCap({ sessionCap: null, projectCaps: [] }, "/x"),
    ).toBeNull();
  });
});
