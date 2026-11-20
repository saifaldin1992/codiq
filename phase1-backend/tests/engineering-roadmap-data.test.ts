import { describe, expect, it } from "vitest";
import { architectureLayers, engineeringGates, roadmapStages } from "../../client/src/lib/engineering-roadmap-data.js";

describe("engineering roadmap documentation data", () => {
  it("covers every planned phase from 12 through 26 exactly once", () => {
    expect(roadmapStages.map((stage) => stage.phase)).toEqual(Array.from({ length: 15 }, (_value, index) => index + 12));
  });

  it("keeps the mandatory review gates visible and each architecture layer identified", () => {
    expect(engineeringGates.map((gate) => gate.id)).toEqual(["scope", "branch", "proof", "review"]);
    expect(new Set(architectureLayers.map((layer) => layer.id)).size).toBe(architectureLayers.length);
    expect(architectureLayers).toHaveLength(5);
  });
});
