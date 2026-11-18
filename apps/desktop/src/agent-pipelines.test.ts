/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPipelineFailure } from "shared-types";

import {
    type AzureRepository,
    parseAzureRemote,
    PipelineError,
    type PipelineFetcher,
    PipelineWatcher,
    type PipelineWatcherDeps,
    tailLog,
} from "./agent-pipelines.js";

vi.mock("electron", () => ({ app: { getLocale: () => "de" }, session: {} }));
vi.mock("./agent.js", () => ({
    askClaude: vi.fn(),
    askCopilot: vi.fn(),
    failure: (error: string) => ({ ok: false, error }),
    getAgentStore: vi.fn(),
    getCredential: vi.fn(),
    getSettings: vi.fn(() => ({ pipelineWatch: false })),
    isDirectory: vi.fn(),
}));
vi.mock("./agent-autopilot.js", () => ({ git: vi.fn() }));

const COLLECTION = "https://tfs.example.com/tfs/team";
const REPO: AzureRepository = { collectionUrl: COLLECTION, project: "Shop", repository: "Web" };
const ME = "user-me";
const STARTED = Date.parse("2026-11-11T10:00:00Z");

function build(id: number, changes: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id,
        buildNumber: `20261111.${id}`,
        result: "failed",
        sourceBranch: "refs/heads/main",
        finishTime: "2026-11-11T10:05:00Z",
        definition: { name: "CI" },
        requestedFor: { id: "someone", displayName: "Bob" },
        _links: { web: { href: `${COLLECTION}/Shop/_build/results?buildId=${id}` } },
        ...changes,
    };
}

/** Answers like Azure DevOps, with the runs in `builds` */
function createFetcher(builds: Record<string, unknown>[]): PipelineFetcher & { urls: string[] } {
    const urls: string[] = [];
    return {
        urls,
        json: vi.fn(async (url: string) => {
            urls.push(url);
            if (url.includes("/_apis/connectionData")) return { authenticatedUser: { id: ME } };
            if (url.includes("/_apis/git/repositories/Web")) return { id: "repo-id", defaultBranch: "refs/heads/main" };
            if (url.includes("/timeline")) {
                return {
                    records: [
                        { type: "Job", name: "Build", result: "failed" },
                        { type: "Task", name: "Run tests", result: "failed", order: 2, log: { id: 7 } },
                        { type: "Task", name: "Restore", result: "succeeded", order: 1 },
                    ],
                };
            }
            if (url.includes("/_apis/build/builds")) return { value: builds };
            throw new PipelineError(404, url);
        }),
        text: vi.fn(async () => "2026-11-11T10:04:59.1234567Z FAIL login.test.ts\n2026-11-11T10:05:00.0000000Z Exit 1"),
    };
}

function createDeps(fetcher: PipelineFetcher): PipelineWatcherDeps & { failures: AgentPipelineFailure[] } {
    const failures: AgentPipelineFailure[] = [];
    return {
        failures,
        findRepositories: async () => [REPO],
        createFetcher: () => fetcher,
        analyse: vi.fn(async () => "A test of the login fails."),
        onFailure: (failure) => failures.push(failure),
        now: () => STARTED,
    };
}

describe("parseAzureRemote", () => {
    it.each([
        [
            "https://tfs.example.com/tfs/team/Shop/_git/Web",
            { collectionUrl: "https://tfs.example.com/tfs/team", project: "Shop", repository: "Web" },
        ],
        [
            "https://alice@dev.azure.com/org/My%20Project/_git/Web.git",
            { collectionUrl: "https://dev.azure.com/org", project: "My%20Project", repository: "Web" },
        ],
        [
            "https://org.visualstudio.com/Shop/_git/Web",
            { collectionUrl: "https://org.visualstudio.com", project: "Shop", repository: "Web" },
        ],
    ])("reads %s", (remote, expected) => {
        expect(parseAzureRemote(remote)).toEqual(expected);
    });

    it.each(["https://github.com/org/web.git", "git@github.com:org/web.git", "https://tfs.example.com/_git/Web"])(
        "ignores %s",
        (remote) => {
            expect(parseAzureRemote(remote)).toBeUndefined();
        },
    );
});

describe("tailLog", () => {
    it("keeps the end of the log without timestamps", () => {
        const log = Array.from({ length: 200 }, (_, i) => `2026-11-11T10:00:00.0000000Z line ${i}`).join("\r\n");

        const tail = tailLog(log).split("\n");

        expect(tail).toHaveLength(80);
        expect(tail.at(-1)).toBe("line 199");
    });
});

describe("PipelineWatcher", () => {
    let watcher: PipelineWatcher | undefined;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        watcher?.stop();
        vi.useRealTimers();
    });

    it("reports failed runs of the default branch, of the user and of the autopilot", async () => {
        const fetcher = createFetcher([
            build(1),
            build(2, { sourceBranch: "refs/heads/feature/x" }),
            build(3, { sourceBranch: "refs/heads/feature/y", requestedFor: { id: ME, displayName: "Alice" } }),
            build(4, { sourceBranch: "refs/heads/pilot/fix-login-1a2b3c" }),
            build(5, { finishTime: "2026-11-11T09:00:00Z" }),
        ]);
        const deps = createDeps(fetcher);
        watcher = new PipelineWatcher(deps);
        watcher.start(1000, 60000);

        await vi.advanceTimersByTimeAsync(1000);

        expect(deps.failures.map((failure) => failure.build.id)).toEqual([1, 3, 4]);
        expect(deps.failures[0]).toMatchObject({
            build: { repository: "Shop/Web", pipeline: "CI", branch: "main", own: false, requestedBy: "Bob" },
            failedSteps: ["Run tests"],
            analysis: "A test of the login fails.",
        });
        expect(deps.failures[1].build.own).toBe(true);
        expect(deps.analyse).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("FAIL login.test.ts"));
        expect(fetcher.urls.find((url) => url.includes("build/builds?"))).toContain("resultFilter=failed");
    });

    it("reports a run only once", async () => {
        const deps = createDeps(createFetcher([build(1)]));
        watcher = new PipelineWatcher(deps);
        watcher.start(1000, 60000);

        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(60000);

        expect(deps.failures).toHaveLength(1);
    });

    it("tells the latest run of each pipeline and branch", async () => {
        const deps = createDeps(
            createFetcher([
                build(9, { result: "succeeded", finishTime: "2026-11-11T11:00:00Z" }),
                build(8, { finishTime: "2026-11-11T10:30:00Z" }),
                build(7, { sourceBranch: "refs/heads/other" }),
            ]),
        );
        watcher = new PipelineWatcher(deps);

        const status = await watcher.getStatus();

        expect(status.repositories).toEqual(["Shop/Web"]);
        expect(status.builds.map((build) => [build.id, build.result])).toEqual([[9, "succeeded"]]);
    });

    it("tells which repositories couldn't be read", async () => {
        const fetcher: PipelineFetcher = {
            json: async (url) => {
                throw new PipelineError(401, url);
            },
            text: async () => "",
        };
        watcher = new PipelineWatcher(createDeps(fetcher));

        const status = await watcher.getStatus();

        expect(status.builds).toEqual([]);
        expect(status.error).toContain("Shop/Web: Azure DevOps answered 401");
    });
});
