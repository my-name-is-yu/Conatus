import { describe, expect, it } from "vitest";
import { formatProgressGap } from "../utils/loop-runner.js";

describe("loop-runner progress formatting", () => {
  it("does not round a non-zero residual gap to 0.00", () => {
    expect(formatProgressGap(0)).toBe("0.00");
    expect(formatProgressGap(0.004)).toBe("<0.01");
    expect(formatProgressGap(0.012)).toBe("0.01");
  });
});
