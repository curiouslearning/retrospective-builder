import { describe, it, expect, vi, afterEach } from "vitest";
import { getCompletedIssuesWithCycleTime } from "./jira.js";

// Stub the config module so it doesn't try to load secrets
vi.mock("../config.js", () => ({
    config: {
        JIRA_EMAIL: "test@example.com",
        JIRA_API_TOKEN: "token",
        JIRA_BASE_URL: "https://example.atlassian.net",
    },
}));

function makeFetchResponse(issues: any[]) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ issues }),
    } as Response);
}

function makeIssue(key: string, assigneeDisplayName: string | null) {
    return {
        key,
        fields: {
            summary: `Summary for ${key}`,
            issuetype: { name: "Story" },
            created: "2024-01-01T00:00:00Z",
            resolutiondate: "2024-02-01T00:00:00Z",
            assignee: assigneeDisplayName ? { displayName: assigneeDisplayName } : null,
        },
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("getCompletedIssuesWithCycleTime", () => {
    it("includes issues not assigned to Content Team", async () => {
        const mockIssues = [
            makeIssue("BTT-1", "Alice"),
            makeIssue("BTT-2", null),
        ];
        vi.stubGlobal("fetch", () => makeFetchResponse(mockIssues));

        const result = await getCompletedIssuesWithCycleTime("BTT", 30);

        expect(result).toHaveLength(2);
        expect(result.map((i: { key: string }) => i.key)).toEqual(["BTT-1", "BTT-2"]);
    });

    it("excludes issues assigned to Content Team", async () => {
        const mockIssues = [
            makeIssue("BTT-1", "Alice"),
            makeIssue("BTT-2", "Content Team"),
            makeIssue("BTT-3", "Bob"),
        ];
        vi.stubGlobal("fetch", () => makeFetchResponse(mockIssues));

        const result = await getCompletedIssuesWithCycleTime("BTT", 30);

        expect(result).toHaveLength(2);
        expect(result.map((i: { key: string }) => i.key)).toEqual(["BTT-1", "BTT-3"]);
    });

    it("excludes all issues when all are assigned to Content Team", async () => {
        const mockIssues = [
            makeIssue("BTT-1", "Content Team"),
            makeIssue("BTT-2", "Content Team"),
        ];
        vi.stubGlobal("fetch", () => makeFetchResponse(mockIssues));

        const result = await getCompletedIssuesWithCycleTime("BTT", 30);

        expect(result).toHaveLength(0);
    });

    it("includes issues with a null (unassigned) assignee", async () => {
        const mockIssues = [makeIssue("BTT-1", null)];
        vi.stubGlobal("fetch", () => makeFetchResponse(mockIssues));

        const result = await getCompletedIssuesWithCycleTime("BTT", 30);

        expect(result).toHaveLength(1);
        expect(result[0].key).toBe("BTT-1");
    });

    it("maps issue fields correctly", async () => {
        const mockIssues = [makeIssue("BTT-5", "Alice")];
        vi.stubGlobal("fetch", () => makeFetchResponse(mockIssues));

        const result = await getCompletedIssuesWithCycleTime("BTT", 30);

        expect(result[0]).toEqual({
            key: "BTT-5",
            summary: "Summary for BTT-5",
            issueType: "Story",
            created: "2024-01-01T00:00:00Z",
            completed: "2024-02-01T00:00:00Z",
        });
    });
});
