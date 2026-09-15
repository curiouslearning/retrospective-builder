import { getCompletedIssuesWithCycleTime } from "../integrations/jira.js";
import { calculateCycleTimesForIssues } from "./analytics.js";
import { roundHalfUp } from "./workingDays.js";

export const ESTIMATION_TEAMS = ["MR", "FM", "AJ"] as const;
const MIN_SAMPLE_SIZE = 10;

// Hardcoded developer count per team
export const DEV_COUNTS: Record<string, number> = {
    MR: 2,
    FM: 2,
    AJ: 2,
};

export type TeamMetrics = {
    projectKey: string;
    avgCycleTime: number;   // mean working days per completed task
    taskCount: number;      // completed tasks in the window
    excluded: boolean;      // true if below MIN_SAMPLE_SIZE
};

export type EstimationResult = {
    low: number;        // best-case working days
    high: number;       // worst-case working days
    lowTeam: string;    // project key with the lowest team estimate
    highTeam: string;   // project key with the highest team estimate
};

export async function fetchTeamMetrics(projectKey: string, daysBack: number = 90): Promise<TeamMetrics> {
    const completedIssues = await getCompletedIssuesWithCycleTime(projectKey, daysBack);
    const taskCount = completedIssues.length;

    if (taskCount < MIN_SAMPLE_SIZE) {
        return { projectKey, avgCycleTime: 0, taskCount, excluded: true };
    }

    const cycleTimeData = await calculateCycleTimesForIssues(completedIssues);

    const avgCycleTime = cycleTimeData.length === 0
        ? 0
        : roundHalfUp(
            cycleTimeData.reduce((acc, item) => acc + item.cycleTime, 0) / cycleTimeData.length
          );

    return { projectKey, avgCycleTime, taskCount, excluded: false };
}

export async function fetchAllTeamMetrics(daysBack: number = 90): Promise<TeamMetrics[]> {
    return Promise.all(
        ESTIMATION_TEAMS.map(key => fetchTeamMetrics(key, daysBack))
    );
}

/**
 * Computes a best/worst-case day range for a given task count.
 *
 * Per team:
 *   tasks_per_dev  = ceil(taskCount ÷ devCount)
 *   team_estimate  = tasks_per_dev × avgCycleTime
 *
 * low  = min(team_estimate across all teams)
 * high = max(team_estimate across all teams)
 *
 * Returns null if taskCount <= 0 or no team has sufficient data.
 */
export function computeEstimate(taskCount: number, metrics: TeamMetrics[]): EstimationResult | null {
    if (taskCount <= 0) return null;

    const included = metrics.filter(m => !m.excluded && m.avgCycleTime > 0);
    if (included.length === 0) return null;

    const estimates = included.map(m => {
        const devCount = DEV_COUNTS[m.projectKey] ?? 1;
        const tasksPerDev = Math.ceil(taskCount / devCount);
        return { projectKey: m.projectKey, estimate: tasksPerDev * m.avgCycleTime };
    });

    const lowest  = estimates.reduce((a, b) => a.estimate < b.estimate ? a : b);
    const highest = estimates.reduce((a, b) => a.estimate > b.estimate ? a : b);

    return {
        low:      lowest.estimate,
        high:     highest.estimate,
        lowTeam:  lowest.projectKey,
        highTeam: highest.projectKey,
    };
}
