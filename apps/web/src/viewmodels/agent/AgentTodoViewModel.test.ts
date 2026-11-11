/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach, type Mocked, type MockedFunction } from "vitest";
import type { AgentFileDiff, AgentStatus, AgentTask } from "shared-types";

import { AgentTodoViewModel, buildChatReport, toRunError, toTodoItem } from "./AgentTodoViewModel";
import { AgentTaskStore } from "../../agent/AgentTaskStore";
import type { AgentApi } from "../../agent/AgentApi";

const STATUS: AgentStatus = {
    provider: "claude",
    instructions: "",
    replySuggestions: true,
    taskDetection: true,
    autoInvestigate: false,
    autopilot: false,
    autopilotCommands: [],
    workspacePath: "/work",
    codingCli: "claude",
    connected: { claude: true, copilot: false },
    recentProjects: ["/projects/app", "/Work"],
};

const TASKS: AgentTask[] = [
    {
        id: "1",
        title: "Create a ticket",
        details: "For the login bug",
        done: false,
        createdAt: 1_000,
        source: { roomId: "!team:example.org", roomName: "Team", sender: "Bob", eventId: "$ask" },
        run: { mode: "implement", state: "finished", startedAt: 1, summary: "Fixed", changedFiles: ["a.ts"] },
    },
    { id: "2", title: "Call Dave", details: "", done: true, createdAt: 2_000 },
    {
        id: "3",
        title: "Fix the typo",
        details: "",
        done: true,
        createdAt: 500,
        source: { roomId: "!dave:example.org", roomName: "Dave", sender: "Dave", eventId: "$typo" },
        run: {
            mode: "autopilot",
            state: "finished",
            startedAt: 1,
            summary: "Fixed the label.",
            changedFiles: ["Login.tsx"],
            steps: [{ kind: "edit", text: "Login.tsx", at: 0 }],
            branch: {
                name: "pilot/fix-the-typo-abc123",
                base: "main",
                baseCommit: "0000000000",
                repositoryPath: "/work",
                worktreePath: "/data/worktrees/abc",
                commit: "3f9e2a1b2c3d",
                pushed: true,
                pullRequestUrl: "https://github.com/example/app/compare/main...pilot/fix-the-typo-abc123",
            },
        },
    },
];

const DIFF_FILE: AgentFileDiff = {
    path: "Login.tsx",
    status: "modified",
    additions: 1,
    deletions: 1,
    truncated: false,
    lines: [
        { type: "remove", text: "-Sign inn" },
        { type: "add", text: "+Sign in" },
    ],
};

describe("AgentTodoViewModel", () => {
    let agent: Mocked<AgentApi>;
    let store: AgentTaskStore;
    let onOpenChat: Mocked<(roomId: string, eventId?: string) => void>;
    let onSendToChat: MockedFunction<(roomId: string, eventId: string | undefined, text: string) => Promise<void>>;
    let vm: AgentTodoViewModel;

    beforeEach(async () => {
        agent = {
            getStatus: vi.fn().mockResolvedValue(STATUS),
            getTasks: vi.fn().mockResolvedValue({ ok: true, data: TASKS }),
            pickFolder: vi.fn().mockResolvedValue({ ok: true, data: "/projects/new" }),
            onTaskProgress: vi.fn(() => () => {}),
        } as unknown as Mocked<AgentApi>;
        store = new AgentTaskStore();
        await store.start(agent, "@alice:example.org");
        vi.spyOn(store, "addTasks").mockResolvedValue([]);
        vi.spyOn(store, "setDone").mockResolvedValue();
        vi.spyOn(store, "deleteTask").mockResolvedValue();
        vi.spyOn(store, "runTask").mockResolvedValue();
        vi.spyOn(store, "openInCli").mockResolvedValue(undefined);
        vi.spyOn(store, "getDiff").mockResolvedValue({ ok: true, data: [DIFF_FILE] });
        vi.spyOn(store, "removeWorktree").mockResolvedValue();
        vi.spyOn(store, "openFolder").mockResolvedValue(undefined);
        onOpenChat = vi.fn();
        onSendToChat = vi.fn().mockResolvedValue(undefined);
        vm = new AgentTodoViewModel({ store, agent, onOpenChat, onSendToChat });
    });

    afterEach(() => {
        vm.dispose();
        store.stop();
    });

    it("shows the open tasks and the counts", async () => {
        await vi.waitFor(() => expect(vm.getSnapshot().canRun).toBe(true));

        expect(vm.getSnapshot()).toMatchObject({ filter: "open", openCount: 1, doneCount: 2 });
        expect(vm.getSnapshot().items).toEqual([
            expect.objectContaining({
                id: "1",
                title: "Create a ticket",
                sender: "Bob",
                chatName: "Team",
                canOpenChat: true,
                run: {
                    mode: "implement",
                    state: "finished",
                    summary: "Fixed",
                    changedFiles: ["a.ts"],
                    error: undefined,
                    steps: [],
                    branch: undefined,
                },
                chatReport: "Done: Create a ticket\n\nFixed",
            }),
        ]);
    });

    it("offers the recent projects and the workspace, without repeats, and the coding CLI", async () => {
        await vi.waitFor(() => expect(vm.getSnapshot().projects).toEqual(["/projects/app", "/Work"]));

        expect(vm.getSnapshot()).toMatchObject({ project: "/projects/app", cli: "claude" });
    });

    it("chooses a project, from the list or from the folder dialog", async () => {
        await vi.waitFor(() => expect(vm.getSnapshot().projects).toHaveLength(2));

        vm.selectProject("/Work");
        expect(vm.getSnapshot().project).toBe("/Work");

        vm.chooseProject();
        await vi.waitFor(() => expect(vm.getSnapshot().project).toBe("/projects/new"));
        expect(vm.getSnapshot().projects).toEqual(["/projects/new", "/projects/app", "/Work"]);
    });

    it("keeps the project when the folder dialog is cancelled", async () => {
        await vi.waitFor(() => expect(vm.getSnapshot().project).toBe("/projects/app"));
        agent.pickFolder.mockResolvedValue({ ok: true, data: undefined });

        vm.chooseProject();

        await vi.waitFor(() => expect(agent.pickFolder).toHaveBeenCalled());
        expect(vm.getSnapshot().project).toBe("/projects/app");
    });

    it("opens a task in the coding CLI and puts the project first", async () => {
        await vi.waitFor(() => expect(vm.getSnapshot().projects).toHaveLength(2));
        vm.selectProject("/Work");

        vm.openInCli("1", "Add a test");

        expect(vm.getSnapshot().launch).toEqual({ id: "1", state: "opening" });
        await vi.waitFor(() => expect(vm.getSnapshot().launch).toEqual({ id: "1", state: "opened" }));
        expect(store.openInCli).toHaveBeenCalledWith("1", "/Work", "Add a test");
        expect(vm.getSnapshot().projects).toEqual(["/Work", "/projects/app"]);
    });

    it.each([
        ["no_workspace", "folder_missing"],
        ["unavailable", "unknown"],
    ] as const)("shows why a task couldn't be opened: %s", async (error, expected) => {
        await vi.waitFor(() => expect(vm.getSnapshot().project).toBeDefined());
        vi.mocked(store.openInCli).mockResolvedValue(error);

        vm.openInCli("1", "");

        await vi.waitFor(() => expect(vm.getSnapshot().launch).toEqual({ id: "1", state: "failed", error: expected }));
    });

    it("opens nothing without a project", async () => {
        agent.getStatus.mockResolvedValue({ ...STATUS, recentProjects: [], workspacePath: undefined });
        const other = new AgentTodoViewModel({ store, agent, onOpenChat, onSendToChat });
        await vi.waitFor(() => expect(agent.getStatus).toHaveBeenCalledTimes(2));

        other.openInCli("1", "");

        expect(store.openInCli).not.toHaveBeenCalled();
        expect(other.getSnapshot().projects).toEqual([]);
        expect(other.getSnapshot().launch).toBeUndefined();
        other.dispose();
    });

    it("shows the done tasks", () => {
        vm.setFilter("done");

        expect(vm.getSnapshot().items.map((item) => item.id)).toEqual(["2", "3"]);
    });

    it("can't let the agent work without a workspace", async () => {
        agent.getStatus.mockResolvedValue({ ...STATUS, workspacePath: undefined });
        const other = new AgentTodoViewModel({ store, agent, onOpenChat, onSendToChat });

        await vi.waitFor(() => expect(agent.getStatus).toHaveBeenCalledTimes(2));
        expect(other.getSnapshot().canRun).toBe(false);
        other.dispose();
    });

    it("follows changes of the list", async () => {
        vi.mocked(store.addTasks).mockRestore();
        agent.addTasks = vi.fn().mockResolvedValue({
            ok: true,
            data: [{ id: "3", title: "New", details: "", done: false, createdAt: 3_000 }],
        });

        await store.addTasks([{ title: "New", details: "" }]);

        expect(vm.getSnapshot().items.map((item) => item.id)).toEqual(["3", "1"]);
        expect(vm.getSnapshot().openCount).toBe(2);
    });

    it("passes the actions to the store", () => {
        vm.addTask("Call Erin");
        vm.setDone("1", true);
        vm.deleteTask("2");
        vm.runTask("1", "investigate");

        expect(store.addTasks).toHaveBeenCalledWith([{ title: "Call Erin", details: "" }]);
        expect(store.setDone).toHaveBeenCalledWith("1", true);
        expect(store.deleteTask).toHaveBeenCalledWith("2");
        expect(store.runTask).toHaveBeenCalledWith("1", "investigate");
    });

    it("opens the chat of a task at the message that asked for it", () => {
        vm.openChat("1");
        vm.openChat("2");

        expect(onOpenChat).toHaveBeenCalledTimes(1);
        expect(onOpenChat).toHaveBeenCalledWith("!team:example.org", "$ask");
    });

    it("shows a task the user added without a chat", () => {
        expect(toTodoItem(TASKS[1])).toMatchObject({ sender: undefined, chatName: undefined, canOpenChat: false });
    });

    it.each([
        ["no_workspace", "no_workspace"],
        ["no_repository", "no_repository"],
        ["not_connected", "not_connected"],
        ["rate_limited", "rate_limited"],
        ["refused", "unknown"],
        [undefined, "unknown"],
    ] as const)("shows the error %s as %s", (error, expected) => {
        expect(toRunError(error)).toBe(expected);
    });

    describe("the autopilot", () => {
        it("shows its steps, its branch with the short commit, and what to tell the chat", () => {
            expect(toTodoItem(TASKS[2])).toMatchObject({
                run: {
                    mode: "autopilot",
                    steps: [{ kind: "edit", text: "Login.tsx", time: expect.any(String), failed: false }],
                    branch: {
                        name: "pilot/fix-the-typo-abc123",
                        base: "main",
                        commit: "3f9e2a1",
                        pushed: true,
                        pullRequestUrl: "https://github.com/example/app/compare/main...pilot/fix-the-typo-abc123",
                        hasWorktree: true,
                    },
                },
                chatReport:
                    "Done: Fix the typo\n\nFixed the label.\n\nBranch: pilot/fix-the-typo-abc123\n" +
                    "Pull request: https://github.com/example/app/compare/main...pilot/fix-the-typo-abc123",
            });
        });

        it("offers no pull request for a branch that wasn't pushed", () => {
            const run = TASKS[2].run!;
            const task = {
                ...TASKS[2],
                run: { ...run, branch: { ...run.branch!, pushed: false, pushError: "denied" } },
            };

            const item = toTodoItem(task);

            expect(item.run?.branch).toMatchObject({ pushed: false, pushError: "denied", pullRequestUrl: undefined });
            expect(item.chatReport).toBe("Done: Fix the typo\n\nFixed the label.\n\nBranch: pilot/fix-the-typo-abc123");
        });

        it.each([
            ["a task without a chat", TASKS[1]],
            ["a run that is still going", { ...TASKS[0], run: { ...TASKS[0].run!, state: "running" as const } }],
        ])("has nothing to tell the chat for %s", (_, task) => {
            expect(buildChatReport(task)).toBeUndefined();
        });

        it("shows the changes of a task, and hides them again", async () => {
            vm.toggleDiff("3");

            expect(vm.getSnapshot().diff).toEqual({ id: "3", state: "loading", files: [] });
            await vi.waitFor(() =>
                expect(vm.getSnapshot().diff).toEqual({ id: "3", state: "loaded", files: [DIFF_FILE] }),
            );
            expect(store.getDiff).toHaveBeenCalledWith("3");

            vm.toggleDiff("3");
            expect(vm.getSnapshot().diff).toBeUndefined();
        });

        it("says when the changes couldn't be read", async () => {
            vi.mocked(store.getDiff).mockResolvedValue({ ok: false, error: "not_found" });

            vm.toggleDiff("3");

            await vi.waitFor(() => expect(vm.getSnapshot().diff).toEqual({ id: "3", state: "failed", files: [] }));
        });

        it("opens the worktree, continues in the CLI there, and removes it", () => {
            vm.toggleDiff("3");
            vm.openWorktree("3");
            vm.continueInCli("3");
            vm.removeWorktree("3");

            expect(store.openFolder).toHaveBeenCalledWith("3");
            expect(store.openInCli).toHaveBeenCalledWith("3", "/data/worktrees/abc", "");
            expect(store.removeWorktree).toHaveBeenCalledWith("3");
            expect(vm.getSnapshot().diff).toBeUndefined();
        });

        it("doesn't continue in the CLI without a worktree", () => {
            vm.continueInCli("1");

            expect(store.openInCli).not.toHaveBeenCalled();
        });

        it("tells the chat, as a reply to the message that asked", async () => {
            vm.reportToChat("3", "Done!");

            expect(vm.getSnapshot().chatReport).toEqual({ id: "3", state: "sending" });
            await vi.waitFor(() => expect(vm.getSnapshot().chatReport).toEqual({ id: "3", state: "sent" }));
            expect(onSendToChat).toHaveBeenCalledWith("!dave:example.org", "$typo", "Done!");
        });

        it("says when the chat couldn't be told", async () => {
            onSendToChat.mockRejectedValue(new Error("offline"));

            vm.reportToChat("3", "Done!");

            await vi.waitFor(() => expect(vm.getSnapshot().chatReport).toEqual({ id: "3", state: "failed" }));
        });

        it("tells no chat for a task the user added", () => {
            vm.reportToChat("2", "Done!");

            expect(onSendToChat).not.toHaveBeenCalled();
            expect(vm.getSnapshot().chatReport).toBeUndefined();
        });
    });
});
