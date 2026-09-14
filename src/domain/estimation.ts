import { getCompletedIssuesWithCycleTime } from "../integrations/jira.js";
import { calculateCycleTimesForIssues } from "./analytics.js";
import { workingDaysBetween, roundHalfUp } from "./workingDays.js";

export const ESTIMATION_TEAMS = ["MR", "FM", "AJ"] as const;
const MIN_SAMPLE_SIZE = 10;

export type TeamMetrics = {
    projectKey: string;
    avgCycleTime: number;   // mean working days per completed task
    throughput: number;     // completed tasks per working day
    taskCount: number;      // completed tasks in the window
    excluded: boolean;      // true if below MIN_SAMPLE_SIZE
};

export type EstimationResult = {
    low: number;        // best-case working days (rounded)
    high: number;       // worst-case working days (rounded)
    lowTeam: string;    // project key anchoring the low end (fastest throughput)
    highTeam: string;   // project key anchoring the high end (slowest cycle time)
    floored: boolean;   // true if low was raised to the floor value
};

export function workingDaysInWindow(daysBack: number): number {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - daysBack);
    return workingDaysBetween(start, end);
}

export async function fetchTeamMetrics(projectKey: string, daysBack: number = 90): Promise<TeamMetrics> {
    const completedIssues = await getCompletedIssuesWithCycleTime(projectKey, daysBack);
    const taskCount = completedIssues.length;

    if (taskCount < MIN_SAMPLE_SIZE) {
        return { projectKey, avgCycleTime: 0, throughput: 0, taskCount, excluded: true };
    }

    const cycleTimeData = await calculateCycleTimesForIssues(completedIssues);

    const avgCycleTime = cycleTimeData.length === 0
        ? 0
        : roundHalfUp(
            cycleTimeData.reduce((acc, item) => acc + item.cycleTime, 0) / cycleTimeData.length
          );

    const workingDays = workingDaysInWindow(daysBack);
    const throughput = workingDays > 0 ? taskCount / workingDays : 0;

    return { projectKey, avgCycleTime, throughput, taskCount, excluded: false };
}

export async function fetchAllTeamMetrics(daysBack: number = 90): Promise<TeamMetrics[]> {
    return Promise.all(
        ESTIMATION_TEAMS.map(key => fetchTeamMetrics(key, daysBack))
    );
}

/**
 * Computes a best/worst-case day range for a given task count.
 *
 * High end (sequential / worst case): taskCount × slowest team's avg cycle time
 * Low end (parallel / best case):     taskCount ÷ fastest team's throughput
 * Floor: if low < fastest cycle time across all included teams, raise it to that value.
 *
 * Returns null if no team has sufficient data.
 */
export function computeEstimate(taskCount: number, metrics: TeamMetrics[]): EstimationResult | null {
    const included = metrics.filter(m => !m.excluded && m.avgCycleTime > 0 && m.throughput > 0);
    if (included.length === 0) return null;

    // Worst case: highest average cycle time (sequential)
    const slowest = included.reduce((a, b) => a.avgCycleTime > b.avgCycleTime ? a : b);
    // Best case: highest throughput (parallel)
    const fastest = included.reduce((a, b) => a.throughput > b.throughput ? a : b);

    const high = taskCount * slowest.avgCycleTime;

    let low = taskCount / fastest.throughput;

    // Floor: fastest single-ticket cycle time across all included teams
    const floorValue = Math.min(...included.map(m => m.avgCycleTime));
    const floored = low < floorValue;
    if (floored) low = floorValue;

    return {
        low: roundHalfUp(low),
        high: roundHalfUp(high),
        lowTeam: fastest.projectKey,
        highTeam: slowest.projectKey,
        floored,
    };
}
