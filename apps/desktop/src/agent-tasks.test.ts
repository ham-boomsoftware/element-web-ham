/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";
import type { AgentTask, AgentTaskDetectionRequest } from "shared-types";

import {
    addAgentTasks,
    buildCommitMessage,
    buildDetectionSystemPrompt,
    buildRunSystemPrompt,
    deleteAgentTask,
    detectAgentTasks,
    getAgentTaskDiff,
    getAgentTasks,
    openAgentTaskFolder,
    parseDetectedTasks,
    pickAgentWorkspace,
    removeAgentTaskWorktree,
    runAgentTask,
    setTaskProgressListener,
    updateAgentTask,
} from "./agent-tasks.js";
import { stopCopilot } from "./agent.js";
import { git } from "./agent-autopilot.js";

const { storeData, anthropic, copilot, dialog, paths, shell } = vi.hoisted(() => ({
    storeData: {} as Record<string, unknown>,
    anthropic: { messagesCreate: vi.fn() },
    copilot: {
        createSession: vi.fn(),
        sendAndWait: vi.fn(),
        disconnect: vi.fn(async () => {}),
        deleteSession: vi.fn(async () => {}),
    },
    dialog: { showOpenDialog: vi.fn() },
    paths: { userData: "/roaming/Element" },
    shell: { openPath: vi.fn(async () => "") },
}));

vi.mock("electron", () => ({
    app: { getPath: vi.fn(() => paths.userData) },
    safeStorage: {
        isEncryptionAvailable: () => true,
        decryptString: (buffer: Buffer) => buffer.toString().replace(/^encrypted:/, ""),
    },
    dialog,
    shell,
}));
vi.mock("electron-store", () => ({
    default: vi.fn(function (this: Record<string, unknown>) {
        this.get = (key: string) => storeData[key];
        this.set = (key: string, value: unknown) => {
            storeData[key] = structuredClone(value);
        };
    }),
}));
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
    const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.beta = { messages: { create: anthropic.messagesCreate } };
    });
    Object.assign(MockAnthropic, {
        AuthenticationError: actual.AuthenticationError,
        PermissionDeniedError: actual.PermissionDeniedError,
        RateLimitError: actual.RateLimitError,
    });
    return { ...actual, default: MockAnthropic };
});
vi.mock("@github/copilot-sdk", () => ({
    CopilotClient: vi.fn(function (this: Record<string, unknown>) {
        Object.assign(this, {
            start: vi.fn(async () => {}),
            stop: vi.fn(async () => []),
            createSession: copilot.createSession,
            deleteSession: copilot.deleteSession,
        });
    }),
}));

const USER = "@alice:example.org";

function connect(provider: "claude" | "copilot"): void {
    storeData.secrets = { [provider]: Buffer.from("encrypted:secret").toString("base64") };
}

/** A text answer of Claude */
function claudeText(text: string): unknown {
    return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}

const detectionRequest: AgentTaskDetectionRequest = {
    ownName: "Alice",
    chatName: "Team",
    isDirect: false,
    messages: [
        { sender: "Alice", own: true, text: "Morning!" },
        { sender: "Bob", own: false, text: "Alice, can you create a ticket for the login bug?" },
    ],
    newCount: 1,
    openTasks: ["Review the release notes"],
};

describe("agent tasks", () => {
    let workspace: string;

    beforeEach(async () => {
        await stopCopilot();
        for (const key of Object.keys(storeData)) delete storeData[key];
        vi.clearAllMocks();
        workspace = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tasks-"));
        await fs.writeFile(path.join(workspace, "login.ts"), "export const login = () => false;\n");
        copilot.createSession.mockResolvedValue({
            sessionId: "session-1",
            sendAndWait: copilot.sendAndWait,
            disconnect: copilot.disconnect,
        });
    });

    afterEach(async () => {
        await fs.rm(workspace, { recursive: true, force: true });
    });

    describe("the list", () => {
        it("adds tasks, newest first, and keeps them per user", () => {
            vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(2000);
            const first = addAgentTasks(USER, [{ title: " Create a ticket ", details: "For Bob" }]);
            addAgentTasks(USER, [
                {
                    title: "Look at the build",
                    source: { roomId: "!team:example.org", roomName: "Team", sender: "Bob", eventId: "$1" },
                },
            ]);

            expect(first).toMatchObject({ ok: true, data: [{ title: "Create a ticket", details: "For Bob" }] });
            expect(getAgentTasks(USER)).toMatchObject({
                ok: true,
                data: [
                    {
                        title: "Look at the build",
                        details: "",
                        done: false,
                        createdAt: 2000,
                        source: { sender: "Bob" },
                    },
                    { title: "Create a ticket", done: false, createdAt: 1000 },
                ],
            });
            expect(getAgentTasks("@bob:example.org")).toEqual({ ok: true, data: [] });
        });

        it.each([
            [USER, [{ title: "" }]],
            [USER, [{ title: "Fine" }, { details: "no title" }]],
            [USER, [{ title: "Bad source", source: { roomId: "" } }]],
            [USER, "not a list"],
            ["", [{ title: "No user" }]],
        ])("refuses invalid tasks for %s: %j", (userId, tasks) => {
            expect(addAgentTasks(userId, tasks)).toMatchObject({ ok: false, error: "invalid_request" });
            expect(storeData.tasks).toBeUndefined();
        });

        it("changes and deletes tasks", () => {
            const added = addAgentTasks(USER, [{ title: "Create a ticket" }]);
            const id = added.ok ? added.data[0].id : "";

            expect(updateAgentTask(USER, id, { done: true, title: "Create the ticket" })).toMatchObject({
                ok: true,
                data: { id, done: true, title: "Create the ticket" },
            });
            expect(updateAgentTask(USER, "unknown", { done: true })).toMatchObject({ ok: false, error: "not_found" });
            expect(updateAgentTask(USER, id, { done: "yes" })).toMatchObject({ ok: false, error: "invalid_request" });

            expect(deleteAgentTask(USER, id)).toEqual({ ok: true, data: undefined });
            expect(deleteAgentTask(USER, id)).toMatchObject({ ok: false, error: "not_found" });
            expect(getAgentTasks(USER)).toEqual({ ok: true, data: [] });
        });

        it("shows a run that was cut off by closing the app as failed", () => {
            storeData.tasks = {
                [USER]: [
                    {
                        id: "task-1",
                        title: "Fix the login",
                        details: "",
                        done: false,
                        createdAt: 1,
                        run: { mode: "implement", state: "running", startedAt: 1 },
                    } satisfies AgentTask,
                ],
            };

            expect(getAgentTasks(USER)).toMatchObject({
                ok: true,
                data: [{ run: { state: "failed", error: "unavailable" } }],
            });
        });
    });

    describe("picking the workspace", () => {
        it("saves the chosen folder", async () => {
            dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [workspace] });

            expect(await pickAgentWorkspace()).toEqual({ ok: true, data: workspace });
            expect(storeData.settings).toMatchObject({ workspacePath: workspace });
        });

        it("changes nothing when the dialog is cancelled", async () => {
            dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

            expect(await pickAgentWorkspace()).toEqual({ ok: true, data: undefined });
            expect(storeData.settings).toBeUndefined();
        });
    });

    describe("finding tasks", () => {
        it("asks the model for the requests in the new messages only", async () => {
            connect("claude");
            anthropic.messagesCreate.mockResolvedValue(
                claudeText('[{"title": "Create a ticket for the login bug", "details": "Bob asked for it"}]'),
            );

            expect(await detectAgentTasks(detectionRequest)).toEqual({
                ok: true,
                data: [{ title: "Create a ticket for the login bug", details: "Bob asked for it" }],
            });
            const { system, messages } = anthropic.messagesCreate.mock.calls[0][0];
            expect(system).toContain('the group chat "Team"');
            expect(messages[0].content).toBe(
                [
                    "Already on the to-do list:",
                    "- Review the release notes",
                    "",
                    "Earlier messages, for context:",
                    "Alice: Morning!",
                    "",
                    "New messages:",
                    "Bob: Alice, can you create a ticket for the login bug?",
                ].join("\n"),
            );
        });

        it("asks Copilot when it is the provider", async () => {
            connect("copilot");
            storeData.settings = { provider: "copilot" };
            copilot.sendAndWait.mockResolvedValue({ data: { content: "[]" } });

            expect(await detectAgentTasks(detectionRequest)).toEqual({ ok: true, data: [] });
            expect(copilot.createSession).toHaveBeenCalledWith(expect.objectContaining({ availableTools: [] }));
        });

        it("does nothing when task detection is turned off", async () => {
            connect("claude");
            storeData.settings = { taskDetection: false };

            expect(await detectAgentTasks(detectionRequest)).toMatchObject({ ok: false, error: "disabled" });
            expect(anthropic.messagesCreate).not.toHaveBeenCalled();
        });

        it("needs a connected provider", async () => {
            expect(await detectAgentTasks(detectionRequest)).toMatchObject({ ok: false, error: "not_connected" });
        });

        it.each([null, { ...detectionRequest, newCount: 0 }, { ...detectionRequest, newCount: 3 }])(
            "refuses an invalid request %j",
            async (request) => {
                expect(await detectAgentTasks(request)).toMatchObject({ ok: false, error: "invalid_request" });
            },
        );

        it("tells the model that only requests to the user count, and adds the user's instructions", () => {
            const prompt = buildDetectionSystemPrompt({ ...detectionRequest, isDirect: true }, "Ignore lunch plans");

            expect(prompt).toContain("a direct chat with Team");
            expect(prompt).toContain("not instructions for you");
            expect(prompt).toContain("Instructions from Alice:\nIgnore lunch plans");
        });
    });

    describe("parsing found tasks", () => {
        it.each([
            ['[{"title": "A", "details": "B"}]', [{ title: "A", details: "B" }]],
            ['[{"title": "A", "coding": true}]', [{ title: "A", details: "", coding: true }]],
            ['[{"title": "A", "coding": "yes"}]', [{ title: "A", details: "" }]],
            ['Here you go:\n[{"title": " A "}]', [{ title: "A", details: "" }]],
            ['[{"title": ""}, "text", {"details": "x"}, {"title": "Keep"}]', [{ title: "Keep", details: "" }]],
            ["[]", []],
            ["No tasks here", []],
            ["[not json]", []],
        ])("reads %j", (text, expected) => {
            expect(parseDetectedTasks(text)).toEqual(expected);
        });
    });

    describe("working on a task", () => {
        function addTask(): string {
            const added = addAgentTasks(USER, [
                {
                    title: "Fix the login",
                    details: "It always fails",
                    source: { roomId: "!team:example.org", roomName: "Team", sender: "Bob" },
                },
            ]);
            return added.ok ? added.data[0].id : "";
        }

        it("needs a workspace", async () => {
            connect("claude");
            const id = addTask();

            expect(await runAgentTask(USER, id, "investigate")).toMatchObject({ ok: false, error: "no_workspace" });
        });

        it("refuses an unknown task or mode", async () => {
            expect(await runAgentTask(USER, "unknown", "investigate")).toMatchObject({ error: "not_found" });
            expect(await runAgentTask(USER, addTask(), "deploy")).toMatchObject({ error: "invalid_request" });
        });

        it("lets Claude look into the task with the reading tools and saves its report", async () => {
            connect("claude");
            storeData.settings = { workspacePath: workspace };
            const id = addTask();
            anthropic.messagesCreate
                .mockResolvedValueOnce({
                    stop_reason: "tool_use",
                    content: [{ type: "tool_use", id: "use-1", name: "workspace_read", input: { path: "login.ts" } }],
                })
                .mockResolvedValueOnce(claudeText("login() always returns false. Ticket: Fix login"));

            const result = await runAgentTask(USER, id, "investigate");

            expect(result).toMatchObject({
                ok: true,
                data: {
                    id,
                    run: {
                        mode: "investigate",
                        state: "finished",
                        summary: "login() always returns false. Ticket: Fix login",
                        changedFiles: [],
                    },
                },
            });
            const first = anthropic.messagesCreate.mock.calls[0][0];
            expect(first.tools.map((tool: { name: string }) => tool.name)).toEqual([
                "workspace_list",
                "workspace_read",
                "workspace_search",
            ]);
            expect(first.messages[0].content).toBe("Task: Fix the login\n\nIt always fails\n\nAsked by Bob in Team.");
            // The result of the tool goes back to Claude
            const second = anthropic.messagesCreate.mock.calls[1][0];
            expect(second.messages.at(-1)).toEqual({
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: "use-1",
                        content: "1\texport const login = () => false;\n2\t",
                    },
                ],
            });
            expect(getAgentTasks(USER)).toMatchObject({ data: [{ run: { state: "finished" } }] });
        });

        it("lets Claude change files to implement the task, building on its earlier report", async () => {
            connect("claude");
            storeData.settings = { workspacePath: workspace };
            const id = addTask();
            anthropic.messagesCreate.mockResolvedValueOnce(claudeText("The cause is login.ts"));
            await runAgentTask(USER, id, "investigate");
            anthropic.messagesCreate
                .mockResolvedValueOnce({
                    stop_reason: "tool_use",
                    content: [
                        {
                            type: "tool_use",
                            id: "use-1",
                            name: "workspace_edit",
                            input: { path: "login.ts", old_text: "false", new_text: "true" },
                        },
                    ],
                })
                .mockResolvedValueOnce(claudeText("login() now returns true"));

            const result = await runAgentTask(USER, id, "implement");

            expect(result).toMatchObject({
                ok: true,
                data: { run: { mode: "implement", state: "finished", changedFiles: ["login.ts"] } },
            });
            expect(await fs.readFile(path.join(workspace, "login.ts"), "utf8")).toBe(
                "export const login = () => true;\n",
            );
            const call = anthropic.messagesCreate.mock.calls[1][0];
            expect(call.messages[0].content).toContain("Your earlier report on this task:\nThe cause is login.ts");
            expect(call.tools.map((tool: { name: string }) => tool.name)).toContain("workspace_edit");
        });

        it("saves a failed run with the provider's message", async () => {
            connect("claude");
            storeData.settings = { workspacePath: workspace };
            const id = addTask();
            anthropic.messagesCreate.mockRejectedValue(new Error("overloaded"));

            expect(await runAgentTask(USER, id, "investigate")).toMatchObject({
                ok: true,
                data: { run: { state: "failed", error: "unavailable", summary: "overloaded" } },
            });
        });

        it("refuses a second run of the same task while the first goes on", async () => {
            connect("claude");
            storeData.settings = { workspacePath: workspace };
            const id = addTask();
            let finish: (value: unknown) => void = () => {};
            anthropic.messagesCreate.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

            const first = runAgentTask(USER, id, "investigate");
            await vi.waitFor(() => expect(anthropic.messagesCreate).toHaveBeenCalled());
            expect(getAgentTasks(USER)).toMatchObject({ data: [{ run: { state: "running" } }] });
            expect(await runAgentTask(USER, id, "implement")).toMatchObject({ ok: false, error: "busy" });

            finish(claudeText("Done"));
            expect(await first).toMatchObject({ ok: true, data: { run: { state: "finished" } } });
        });

        it("gives Copilot only the workspace tools", async () => {
            connect("copilot");
            storeData.settings = { provider: "copilot", workspacePath: workspace };
            const id = addTask();
            copilot.sendAndWait.mockResolvedValue({ data: { content: "Report" } });

            expect(await runAgentTask(USER, id, "implement")).toMatchObject({
                ok: true,
                data: { run: { state: "finished", summary: "Report" } },
            });
            const options = copilot.createSession.mock.calls[0][0];
            expect(options.availableTools).toEqual([
                "custom:workspace_list",
                "custom:workspace_read",
                "custom:workspace_search",
                "custom:workspace_write",
                "custom:workspace_edit",
            ]);
            // The tools of the session are the workspace tools
            expect(await options.tools[1].handler({ path: "login.ts" })).toBe(
                "1\texport const login = () => false;\n2\t",
            );
            expect(copilot.deleteSession).toHaveBeenCalledWith("session-1");
        });

        it("tells the agent not to change anything when it only looks into a task", () => {
            expect(buildRunSystemPrompt("investigate", "/work")).toContain("Don't change anything");
            expect(buildRunSystemPrompt("implement", "/work")).toContain("You can't run commands, commit or push");
        });
    });

    describe("the autopilot", () => {
        const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.org"];
        let remote: string;

        beforeEach(async () => {
            // The worktrees are kept with the data of the agent, which goes to the temporary folder here
            paths.userData = path.join(workspace, "..", `${path.basename(workspace)}-data`, "Element");
            vi.stubEnv("LOCALAPPDATA", path.dirname(paths.userData));
            remote = `${workspace}-remote.git`;
            await git(workspace, ["init", "-q", "-b", "main"]);
            await git(workspace, ["add", "-A"]);
            await git(workspace, [...IDENTITY, "commit", "-q", "-m", "Initial"]);
            await git(workspace, ["init", "-q", "--bare", remote]);
            await git(workspace, ["remote", "add", "origin", remote]);
            connect("claude");
        });

        afterEach(async () => {
            setTaskProgressListener(undefined);
            vi.unstubAllEnvs();
            await fs.rm(remote, { recursive: true, force: true });
            await fs.rm(path.dirname(paths.userData), { recursive: true, force: true });
            paths.userData = "/roaming/Element";
        });

        function addCodingTask(): string {
            const added = addAgentTasks(USER, [
                {
                    title: "Fix the login",
                    details: "It always fails",
                    coding: true,
                    source: { roomId: "!team:example.org", roomName: "Team", sender: "Bob" },
                },
            ]);
            return added.ok ? added.data[0].id : "";
        }

        it("does the task on a branch of its own, runs allowed commands, commits, pushes and reports each step", async () => {
            const command = 'node -e "console.log(1)"';
            storeData.settings = { workspacePath: workspace, autopilotCommands: [command] };
            const id = addCodingTask();
            const progress = vi.fn();
            setTaskProgressListener(progress);
            anthropic.messagesCreate
                .mockResolvedValueOnce({
                    stop_reason: "tool_use",
                    content: [
                        {
                            type: "tool_use",
                            id: "use-1",
                            name: "workspace_edit",
                            input: { path: "login.ts", old_text: "false", new_text: "true" },
                        },
                        { type: "tool_use", id: "use-2", name: "workspace_run", input: { command } },
                    ],
                })
                .mockResolvedValueOnce(claudeText("login() returns true now"));

            const result = await runAgentTask(USER, id, "autopilot");

            expect(result).toMatchObject({
                ok: true,
                data: {
                    coding: true,
                    run: {
                        mode: "autopilot",
                        state: "finished",
                        changedFiles: ["login.ts"],
                        branch: { name: expect.stringMatching(/^pilot\/fix-the-login-/), base: "main", pushed: true },
                    },
                },
            });
            const run = result.ok ? result.data.run! : undefined;
            expect(run?.steps?.map((step) => [step.kind, step.failed ?? false])).toEqual([
                ["git", false],
                ["edit", false],
                ["command", false],
                ["git", false],
                ["git", false],
            ]);
            const tools = anthropic.messagesCreate.mock.calls[0][0].tools.map((tool: { name: string }) => tool.name);
            expect(tools).toContain("workspace_run");
            expect(anthropic.messagesCreate.mock.calls[0][0].system).toContain("branch of your own");

            // The working tree of the user is untouched; the change is on the pushed branch
            expect(await fs.readFile(path.join(workspace, "login.ts"), "utf8")).toBe(
                "export const login = () => false;\n",
            );
            const branch = run!.branch!;
            expect(
                (await git(workspace, [`--git-dir=${remote}`, "log", "-1", "--format=%s", branch.name])).trim(),
            ).toBe("Fix the login");

            // Each step went to the renderer as it happened, with the run still going on
            expect(progress).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: USER,
                    taskId: id,
                    run: expect.objectContaining({ state: "running" }),
                }),
            );
            expect(progress.mock.calls.at(-1)?.[0].run).toMatchObject({ state: "finished" });

            expect(await getAgentTaskDiff(USER, id)).toMatchObject({
                ok: true,
                data: [{ path: "login.ts", additions: 1, deletions: 1 }],
            });
            expect(await openAgentTaskFolder(USER, id)).toEqual({ ok: true, data: undefined });
            expect(shell.openPath).toHaveBeenCalledWith(branch.worktreePath);

            expect(await removeAgentTaskWorktree(USER, id)).toMatchObject({
                ok: true,
                data: { run: { branch: { name: branch.name, worktreePath: undefined } } },
            });
            await expect(fs.access(branch.worktreePath!)).rejects.toThrow();
            expect(await openAgentTaskFolder(USER, id)).toMatchObject({ ok: false, error: "not_found" });
        });

        it("does not commit when the agent fails, and keeps the worktree to look at", async () => {
            storeData.settings = { workspacePath: workspace };
            const id = addCodingTask();
            anthropic.messagesCreate.mockRejectedValue(new Error("overloaded"));

            const result = await runAgentTask(USER, id, "autopilot");

            expect(result).toMatchObject({ ok: true, data: { run: { state: "failed", error: "unavailable" } } });
            const branch = result.ok ? result.data.run!.branch! : undefined;
            expect(branch?.commit).toBeUndefined();
            await fs.access(branch!.worktreePath!);
            // Deleting the task removes its worktree, and its branch, which has no commit
            deleteAgentTask(USER, id);
            await vi.waitFor(async () => {
                await expect(fs.access(branch!.worktreePath!)).rejects.toThrow();
                expect((await git(workspace, ["branch", "--list", branch!.name])).trim()).toBe("");
            });
        });

        it("fails with no_repository when the workspace is not in a git repository", async () => {
            await fs.rm(path.join(workspace, ".git"), { recursive: true, force: true });
            storeData.settings = { workspacePath: workspace };
            const id = addCodingTask();

            const result = await runAgentTask(USER, id, "autopilot");

            expect(result).toMatchObject({ ok: true, data: { run: { state: "failed", error: "no_repository" } } });
            expect(anthropic.messagesCreate).not.toHaveBeenCalled();
            expect(await getAgentTaskDiff(USER, id)).toMatchObject({ ok: false, error: "no_repository" });
        });

        it("writes the commit message from the task and the report", () => {
            const message = buildCommitMessage(
                {
                    id: "1",
                    title: "Fix  the\nlogin",
                    details: "",
                    done: false,
                    createdAt: 0,
                    source: { roomId: "!r", roomName: "Team", sender: "Bob" },
                },
                " Changed login.ts ",
            );

            expect(message).toBe(
                "Fix the login\n\nChanged login.ts\n\nRequested by Bob in Team.\n\nDone by the Element Pilot autopilot.",
            );
        });
    });
});
