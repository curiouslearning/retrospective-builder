import { describe, it, expect } from "vitest";
import { computeEstimate, DEV_COUNTS } from "./estimation.js";
import type { TeamMetrics } from "./estimation.js";

// MR, FM, AJ all have devCount=2; unknown keys default to 1
const makeTeam = (projectKey: string, avgCycleTime: number, taskCount = 20): TeamMetrics => ({
    projectKey,
    avgCycleTime,
    taskCount,
    excluded: false,
});

describe("computeEstimate", () => {
    it("returns null for a task count of zero", () => {
        expect(computeEstimate(0, [makeTeam("MR", 5)])).toBeNull();
    });

    it("returns null for a negative task count", () => {
        expect(computeEstimate(-1, [makeTeam("MR", 5)])).toBeNull();
    });

    it("returns null when no teams are included", () => {
        const excluded: TeamMetrics = { projectKey: "MR", avgCycleTime: 0, taskCount: 3, excluded: true };
        expect(computeEstimate(10, [excluded])).toBeNull();
    });

    it("returns null when all included teams have zero cycle time", () => {
        const zero: TeamMetrics = { projectKey: "MR", avgCycleTime: 0, taskCount: 20, excluded: false };
        expect(computeEstimate(10, [zero])).toBeNull();
    });

    it("computes team_estimate as ceil(taskCount / devCount) × avgCycleTime", () => {
        // MR has devCount=2, avgCycleTime=5
        // tasksPerDev = ceil(4 / 2) = 2 → estimate = 2 × 5 = 10
        const result = computeEstimate(4, [makeTeam("MR", 5)]);
        expect(result).not.toBeNull();
        expect(result!.low).toBe(10);
        expect(result!.high).toBe(10);
    });

    it("applies ceiling division for odd task counts", () => {
        // MR has devCount=2, avgCycleTime=5
        // tasksPerDev = ceil(5 / 2) = 3 → estimate = 3 × 5 = 15
        const result = computeEstimate(5, [makeTeam("MR", 5)]);
        expect(result).not.toBeNull();
        expect(result!.low).toBe(15);
        expect(result!.high).toBe(15);
    });

    it("selects min estimate as low end and max as high end", () => {
        // MR: ceil(4/2)*8 = 2*8 = 16
        // FM: ceil(4/2)*4 = 2*4 = 8
        const result = computeEstimate(4, [makeTeam("MR", 8), makeTeam("FM", 4)]);
        expect(result).not.toBeNull();
        expect(result!.low).toBe(8);
        expect(result!.lowTeam).toBe("FM");
        expect(result!.high).toBe(16);
        expect(result!.highTeam).toBe("MR");
    });

    it("computes correctly across all three teams", () => {
        // taskCount=6, all devCount=2 → tasksPerDev = ceil(6/2) = 3
        // AJ: 3 × 3 = 9, MR: 3 × 7 = 21, FM: 3 × 5 = 15
        const result = computeEstimate(6, [makeTeam("AJ", 3), makeTeam("MR", 7), makeTeam("FM", 5)]);
        expect(result).not.toBeNull();
        expect(result!.low).toBe(9);
        expect(result!.lowTeam).toBe("AJ");
        expect(result!.high).toBe(21);
        expect(result!.highTeam).toBe("MR");
    });

    it("defaults devCount to 1 for unknown project keys", () => {
        // Unknown key → devCount=1, tasksPerDev = ceil(5/1) = 5, estimate = 5 × 4 = 20
        const result = computeEstimate(5, [makeTeam("UNKNOWN", 4)]);
        expect(result).not.toBeNull();
        expect(result!.low).toBe(20);
        expect(result!.high).toBe(20);
    });

    it("skips excluded teams", () => {
        const excluded: TeamMetrics = { projectKey: "MR", avgCycleTime: 10, taskCount: 3, excluded: true };
        const included = makeTeam("FM", 4);
        // Only FM: ceil(4/2)*4 = 2*4 = 8
        const result = computeEstimate(4, [excluded, included]);
        expect(result).not.toBeNull();
        expect(result!.lowTeam).toBe("FM");
        expect(result!.highTeam).toBe("FM");
        expect(result!.low).toBe(8);
        expect(result!.high).toBe(8);
    });

    it("DEV_COUNTS covers all three estimation teams", () => {
        expect(DEV_COUNTS["MR"]).toBe(2);
        expect(DEV_COUNTS["FM"]).toBe(2);
        expect(DEV_COUNTS["AJ"]).toBe(2);
    });
});
