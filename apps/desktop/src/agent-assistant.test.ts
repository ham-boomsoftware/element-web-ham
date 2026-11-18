/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "shared-types";

import {
    type AssistantDeps,
    AssistantTools,
    buildAssistantPrompt,
    buildAssistantSystemPrompt,
    chatWithAgentAssistant,
    describeTaskLine,
} from "./agent-assistant.js";
import { runAgentWithTools } from "./agent-tasks.js";

vi.mock("electron", () => ({ app: { getPath: vi.fn() }, shell: { openPath: vi.fn() } }));
vi.mock("./agent.js", () => ({
    askClaude: vi.fn(),
    askCopilot: vi.fn(),
    buildInstructionLines: (ownName: string, instructions: string) =>
        instructions ? ["", `Instructions from ${ownName}:`, instructions] : [],
    failure: (error: string) => ({ ok: false, error }),
    getCredential: vi.fn(),
    getSettings: vi.fn(() => ({ instructions: "Be brief." })),
}));
vi.mock("./agent-tasks.js", () => ({
    addAgentTasks: vi.fn(),
    answerAgentTaskQuestion: vi.fn(),
    findAgentTask: vi.fn(),
    getAgentTasks: vi.fn(),
    runAgentTask: vi.fn(),
    runAgentWithTools: vi.fn(),
    setAgentTaskSchedule: vi.fn(),
    updateAgentTask: vi.fn(),
}));
vi.mock("./agent-pipelines.js", () => ({ getAgentPipelineStatus: vi.fn() }));
vi.mock("./agent-bsm.js", () => ({
    importBsmTicketsForUser: vi.fn(),
    loginToBsm: vi.fn(),
    setBsmProjectFolder: vi.fn(),
}));
vi.mock("./agent-cli.js", () => ({ pickAgentFolder: vi.fn() }));

const USER = "@alice:example.org";

const loginTask: AgentTask = {
    id: "1a2b3c4d-login",
    title: "Fix the login",
    details: "The button does nothing",
    done: false,
    createdAt: 2,
    source: { roomId: "!dm:example.org", roomName: "Bob", sender: "Bob" },
    run: {
        mode: "autopilot",
        state: "running",
        startedAt: 1,
        question: { text: "Which browser?", askedAt: 2 },
    },
};
const doneTask: AgentTask = { id: "9f8e7d6c-done", title: "Write the notes", details: "", done: true, createdAt: 1 };

function createDeps(): AssistantDeps & { [K in keyof AssistantDeps]: ReturnType<typeof vi.fn> } {
    return {
        getTasks: vi.fn(() => ({ ok: true, data: [loginTask, doneTask] })),
        addTasks: vi.fn((_userId, tasks) => ({
            ok: true,
            data: [{ ...tasks[0], id: "5e5e5e5e-new", done: false, createdAt: 3 }],
        })),
        updateTask: vi.fn((_userId, _taskId, changes) => ({ ok: true, data: { ...doneTask, ...changes } })),
        runTask: vi.fn(() => new Promise(() => {})),
        answerQuestion: vi.fn(() => ({ ok: true, data: undefined })),
        getPipelineStatus: vi.fn(async () => ({
            ok: true,
            data: {
                repositories: ["Shop/Web"],
                builds: [
                    {
                        id: 1,
                        repository: "Shop/Web",
                        pipeline: "CI",
                        buildNumber: "20261111.1",
                        result: "failed",
                        branch: "main",
                        finishedAt: new Date(2026, 10, 11, 9, 30).getTime(),
                        own: false,
                    },
                ],
                checkedAt: 1,
            },
        })),
        suggestTimeSlot: vi.fn(async () => ({
            ok: true,
            data: { start: new Date(2026, 10, 12, 9, 0).getTime(), durationMinutes: 90, reason: "Morning is free." },
        })),
        scheduleTask: vi.fn(async () => ({ ok: true, data: loginTask })),
        loginToBsm: vi.fn(async () => ({ ok: true, data: undefined })),
        importBsmTickets: vi.fn(async () => ({
            ok: true,
            data: { listed: 3, added: [ticketTask], updated: [], closed: [], withoutFolder: ["ELL BRS"], errors: [] },
        })),
        setBsmProjectFolder: vi.fn(() => ({ ok: true, data: [ticketTask] })),
        pickFolder: vi.fn(async () => "C:\\projects\\ell"),
    } as never;
}

const ticketTask: AgentTask = {
    id: "7c7c7c7c-ticket",
    title: "ELLBg0169: Themen nach Go Live",
    details: "",
    done: false,
    createdAt: 4,
    ticket: {
        system: "bsm",
        number: "ELLBg0169",
        url: "https://bsm.example/indication/ELLBg0169",
        application: "ELL BRS",
    },
};

describe("AssistantTools for BSM", () => {
    let deps: ReturnType<typeof createDeps>;
    let tools: AssistantTools;

    beforeEach(() => {
        deps = createDeps();
        tools = new AssistantTools(USER, deps);
    });

    it("imports the tickets and names the applications without a project folder", async () => {
        const text = await tools.run("bsm_import", {});

        expect(deps.importBsmTickets).toHaveBeenCalledWith(USER);
        expect(text).toContain("shows 3 tickets");
        expect(text).toContain("ELLBg0169");
        expect(text).toContain("without a project folder: ELL BRS");
        expect(tools.tasksChanged).toBe(true);
    });

    it("lets the user log in when BSM has no login, and imports then", async () => {
        const imported = await deps.importBsmTickets(USER);
        deps.importBsmTickets.mockReset();
        deps.importBsmTickets
            .mockResolvedValueOnce({ ok: false, error: "not_connected" })
            .mockResolvedValueOnce(imported);

        const text = await tools.run("bsm_import", {});

        expect(deps.loginToBsm).toHaveBeenCalledTimes(1);
        expect(deps.importBsmTickets).toHaveBeenCalledTimes(2);
        expect(text).toContain("shows 3 tickets");
    });

    it("tells when the user is still not logged in", async () => {
        deps.importBsmTickets.mockResolvedValue({ ok: false, error: "not_connected" });

        expect(await tools.run("bsm_import", {})).toContain("bsm_login");
    });

    it("opens the login window of BSM", async () => {
        await tools.run("bsm_login", {});

        expect(deps.loginToBsm).toHaveBeenCalled();
    });

    it("sets the project folder of an application from a dialog", async () => {
        const text = await tools.run("set_project_folder", { application: "ELL BRS" });

        expect(deps.pickFolder).toHaveBeenCalled();
        expect(deps.setBsmProjectFolder).toHaveBeenCalledWith(USER, "ELL BRS", "C:\\projects\\ell");
        expect(text).toContain("1 open tasks got it");
    });

    it("uses the folder the user named", async () => {
        await tools.run("set_project_folder", { application: "ELL BRS", folder: "D:\\ell" });

        expect(deps.pickFolder).not.toHaveBeenCalled();
        expect(deps.setBsmProjectFolder).toHaveBeenCalledWith(USER, "ELL BRS", "D:\\ell");
    });

    it("shows the ticket of a task in the list", () => {
        expect(describeTaskLine(ticketTask)).toContain("ticket https://bsm.example/indication/ELLBg0169 (ELL BRS)");
    });
});

describe("AssistantTools", () => {
    let deps: ReturnType<typeof createDeps>;
    let tools: AssistantTools;

    beforeEach(() => {
        deps = createDeps();
        tools = new AssistantTools(USER, deps);
    });

    it("lists the open tasks with their state", async () => {
        const list = await tools.run("list_tasks", {});

        expect(list).toBe(describeTaskLine(loginTask));
        expect(list).toContain("[1a2b3c4d] Fix the login · open · asked by Bob in Bob");
        expect(list).toContain('waits for the answer to: "Which browser?"');
        expect(await tools.run("list_tasks", { include_done: true })).toContain("Write the notes · done");
    });

    it("adds and completes tasks, and tells that the list changed", async () => {
        expect(await tools.run("add_task", { title: "Call Bob", coding: false })).toContain("[5e5e5e5e] Call Bob");
        expect(deps.addTasks).toHaveBeenCalledWith(USER, [{ title: "Call Bob", details: "", coding: undefined }]);

        await tools.run("set_task_done", { task_id: "9f8e7d6c", done: true });

        expect(deps.updateTask).toHaveBeenCalledWith(USER, "9f8e7d6c-done", { done: true });
        expect(tools.tasksChanged).toBe(true);
    });

    it("finds tasks by the start of their ID only if it is unique", async () => {
        expect(await tools.run("show_task", { task_id: "[1a2b3c4d]" })).toContain("The button does nothing");
        expect(await tools.run("show_task", { task_id: "1a" })).toMatch(/^Error: no task with the ID 1a/);
    });

    it("starts the work on a task without waiting for it", async () => {
        vi.useFakeTimers();
        try {
            const started = tools.run("start_task", { task_id: "9f8e7d6c", mode: "autopilot" });
            await vi.advanceTimersByTimeAsync(1000);

            expect(await started).toContain("The autopilot started");
            expect(deps.runTask).toHaveBeenCalledWith(USER, "9f8e7d6c-done", "autopilot");
        } finally {
            vi.useRealTimers();
        }
    });

    it("tells when the work couldn't start", async () => {
        deps.runTask.mockResolvedValue({ ok: false, error: "no_workspace" });

        expect(await tools.run("start_task", { task_id: "9f8e7d6c", mode: "investigate" })).toBe(
            "Error: no project folder is set in the settings of the agent",
        );
    });

    it("answers the question of the agent", async () => {
        expect(await tools.run("answer_question", { task_id: "1a2b3c4d", answer: "Firefox" })).toContain("goes on");
        expect(deps.answerQuestion).toHaveBeenCalledWith(USER, "1a2b3c4d-login", "Firefox");
    });

    it("tells the state of the pipelines", async () => {
        expect(await tools.run("pipeline_status", {})).toContain(
            "- failed: CI 20261111.1 (Shop/Web, branch main), finished 2026-11-11T09:30",
        );
    });

    it("suggests a time and plans a task at a local time", async () => {
        expect(await tools.run("suggest_time", { task_id: "1a2b3c4d" })).toBe(
            "Suggested: 2026-11-12T09:00 for 90 minutes. Morning is free.",
        );

        await tools.run("schedule_task", { task_id: "1a2b3c4d", start: "2026-11-12T09:00", duration_minutes: 90 });

        expect(deps.scheduleTask).toHaveBeenCalledWith(USER, "1a2b3c4d-login", new Date(2026, 10, 12, 9).getTime(), 90);
        expect(await tools.run("schedule_task", { task_id: "1a2b3c4d", start: "soon", duration_minutes: 90 })).toMatch(
            /^Error/,
        );
    });
});

describe("chatWithAgentAssistant", () => {
    it("answers with the tools and tells whether the list changed", async () => {
        vi.mocked(runAgentWithTools).mockImplementation(async (_system, _prompt, tools) => {
            await tools.run("add_task", { title: "Call Bob" });
            return { ok: true, data: "Added it." };
        });
        const deps = createDeps();

        const result = await chatWithAgentAssistant(
            {
                userId: USER,
                ownName: "Alice",
                turns: [
                    { role: "user", text: "Hi" },
                    { role: "assistant", text: "Hello!" },
                    { role: "user", text: "Remind me to call Bob" },
                ],
            },
            deps,
            new Date(2026, 10, 11, 10, 7).getTime(),
        );

        expect(result).toEqual({ ok: true, data: { text: "Added it.", tasksChanged: true } });
        const [system, prompt] = vi.mocked(runAgentWithTools).mock.calls[0];
        expect(system).toContain("It is now Wednesday, 2026-11-11T10:07 local time.");
        expect(system).toContain("Be brief.");
        expect(prompt).toBe(
            buildAssistantPrompt("Alice", [
                { role: "user", text: "Hi" },
                { role: "assistant", text: "Hello!" },
                { role: "user", text: "Remind me to call Bob" },
            ]),
        );
        expect(prompt).toContain("Element Pilot: Hello!");
    });

    it("rejects a chat that doesn't end with a message of the user", async () => {
        const result = await chatWithAgentAssistant({
            userId: USER,
            ownName: "Alice",
            turns: [{ role: "assistant", text: "Hello!" }],
        });

        expect(result).toEqual({ ok: false, error: "invalid_request" });
    });

    it("keeps to the rules in its system prompt", () => {
        expect(buildAssistantSystemPrompt("Alice", "", 0)).toContain("Only start the autopilot");
    });
});
