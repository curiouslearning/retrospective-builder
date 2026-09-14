import { describe, it, expect } from "vitest";
import { computeEstimate, workingDaysInWindow } from "./estimation.js";
import type { TeamMetrics } from "./estimation.js";

const makeTeam = (projectKey: string, avgCycleTime: number, throughput: number, taskCount = 20): TeamMetrics => ({
    projectKey,
    avgCycleTime,
    throughput,
    taskCount,
    excluded: false,
});

describe("workingDaysInWindow", () => {
    it("returns fewer days than the calendar window (weekends excluded)", () => {
        const days = workingDaysInWindow(90);
        // 90 calendar days has at most 90 and at least ~64 working days
        expect(days).toBeGreaterThan(60);
        expect(days).toBeLessThan(90);
    });

    it("returns roughly 5/7 of the calendar days", () => {
        const days = workingDaysInWindow(70);
        expect(days).toBeGreaterThan(45);
        expect(days).toBeLessThan(55);
    });
});

describe("computeEstimate", () => {
    it("returns null when no teams are included", () => {
        const excluded: TeamMetrics = { projectKey: "MR", avgCycleTime: 0, throughput: 0, taskCount: 3, excluded: true };
        expect(computeEstimate(10, [excluded])).toBeNull();
    });

    it("returns null when included teams have zero metrics", () => {
        const zero: TeamMetrics = { projectKey: "MR", avgCycleTime: 0, throughput: 0, taskCount: 20, excluded: false };
        expect(computeEstimate(10, [zero])).toBeNull();
    });

    it("computes high end as taskCount × slowest cycle time", () => {
        const teams = [
            makeTeam("MR", 5, 1.0),  // slowest cycle time
            makeTeam("FM", 3, 1.5),  // fastest throughput
        ];
        const result = computeEstimate(10, teams);
        expect(result).not.toBeNull();
        // high = 10 × 5 = 50
        expect(result!.high).toBe(50);
        expect(result!.highTeam).toBe("MR");
    });

    it("computes low end as taskCount ÷ fastest throughput", () => {
        const teams = [
            makeTeam("MR", 5, 1.0),
            makeTeam("FM", 3, 2.0),  // fastest throughput
        ];
        const result = computeEstimate(10, teams);
        expect(result).not.toBeNull();
        // low = 10 / 2.0 = 5; floor = min(5,3) = 3; 5 >= 3, no floor applied
        expect(result!.low).toBe(5);
        expect(result!.lowTeam).toBe("FM");
        expect(result!.floored).toBe(false);
    });

    it("resolves fastest (throughput) and slowest (cycle time) independently", () => {
        const teams = [
            makeTeam("MR", 8, 0.5),  // slowest cycle time, slowest throughput
            makeTeam("FM", 4, 0.8),
            makeTeam("AJ", 6, 1.2),  // fastest throughput
        ];
        const result = computeEstimate(12, teams);
        expect(result).not.toBeNull();
        // high = 12 × 8 = 96
        expect(result!.high).toBe(96);
        expect(result!.highTeam).toBe("MR");
        // low = 12 / 1.2 = 10; floor = min(8,4,6) = 4; 10 >= 4, no floor
        expect(result!.low).toBe(10);
        expect(result!.lowTeam).toBe("AJ");
    });

    it("applies the floor when task count is small", () => {
        const teams = [
            makeTeam("MR", 5, 1.0),
            makeTeam("FM", 3, 0.5),  // fastest throughput: low = 1 / 0.5 = 2
        ];
        // low = 1 / 0.5 = 2; floor = min(5,3) = 3; 2 < 3, so floor applies
        const result = computeEstimate(1, teams);
        expect(result).not.toBeNull();
        expect(result!.low).toBe(3);
        expect(result!.floored).toBe(true);
    });

    it("does not apply the floor when low already meets the floor", () => {
        const teams = [
            makeTeam("MR", 5, 0.2),  // fastest throughput: low = 10 / 0.2 = 50
            makeTeam("FM", 3, 0.1),
        ];
        const result = computeEstimate(10, teams);
        expect(result).not.toBeNull();
        expect(result!.floored).toBe(false);
        expect(result!.low).toBe(50);
    });

    it("handles a single team correctly", () => {
        const teams = [makeTeam("AJ", 6, 1.0)];
        const result = computeEstimate(5, teams);
        expect(result).not.toBeNull();
        // high = 5 × 6 = 30
        expect(result!.high).toBe(30);
        expect(result!.highTeam).toBe("AJ");
        // low = 5 / 1.0 = 5; floor = 6; 5 < 6, floored
        expect(result!.low).toBe(6);
        expect(result!.floored).toBe(true);
        expect(result!.lowTeam).toBe("AJ");
    });

    it("skips excluded teams", () => {
        const teams = [
            { projectKey: "MR", avgCycleTime: 10, throughput: 0.1, taskCount: 3, excluded: true },
            makeTeam("FM", 4, 1.0),
        ];
        const result = computeEstimate(5, teams);
        expect(result).not.toBeNull();
        // Only FM is included
        expect(result!.highTeam).toBe("FM");
        expect(result!.lowTeam).toBe("FM");
    });

    it("rounds the output using roundHalfUp", () => {
        // throughput = 3, so low = 10 / 3 = 3.333... → rounds to 3
        const teams = [makeTeam("FM", 5, 3.0)];
        const result = computeEstimate(10, teams);
        expect(result).not.toBeNull();
        // low = 10/3 ≈ 3.33; floor = 5; floored → 5
        expect(result!.low).toBe(5);
        // high = 10 × 5 = 50
        expect(result!.high).toBe(50);
    });
});
