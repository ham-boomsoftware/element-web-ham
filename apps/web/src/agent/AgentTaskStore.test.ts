/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { vi, describe, it, expect, beforeEach, afterEach, type Mocked } from "vitest";
import type { AgentTask } from "shared-types";

import { AgentTaskStore, AgentTaskStoreEvent } from "./AgentTaskStore";
import type { AgentApi } from "./AgentApi";

const ALICE = "@alice:example.org";

function mkTask(id: string, changes: Partial<AgentTask> = {}): AgentTask {
    return { id, title: `Task ${id}`, details: "", done: false, createdAt: 1, ...changes };
}

describe("AgentTaskStore", () => {
    let agent: Mocked<AgentApi>;
    let store: AgentTaskStore;

    beforeEach(() => {
        agent = {
            getStatus: vi.fn(),
            setSettings: vi.fn(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            listModels: vi.fn(),
            getRoomRules: vi.fn(),
            setRoomRule: vi.fn(),
            generateReply: vi.fn(),
            generateSuggestions: vi.fn(),
            pickWorkspace: vi.fn(),
            getTasks: vi.fn().mockResolvedValue({ ok: true, data: [mkTask("1"), mkTask("2", { done: true })] }),
            addTasks: vi.fn(async (_userId, tasks) => ({
                ok: true as const,
                data: tasks.map((task, i) => mkTask(`new-${i}`, { ...task, createdAt: 2 })),
            })),
            updateTask: vi.fn(async (_userId, taskId, changes) => ({
                ok: true as const,
                data: mkTask(taskId, changes),
            })),
            deleteTask: vi.fn().mockResolvedValue({ ok: true, data: undefined }),
            detectTasks: vi.fn(),
            runTask: vi.fn(async (_userId, taskId, mode) => ({
                ok: true as const,
                data: mkTask(taskId, { run: { mode, state: "finished", startedAt: 1, summary: "Report" } }),
            })),
            pickFolder: vi.fn(),
            openTaskInCli: vi.fn(),
        };
        store = new AgentTaskStore();
    });

    afterEach(() => {
        store.stop();
    });

    it("reads the list of the user from the platform", async () => {
        const onUpdate = vi.fn();
        store.on(AgentTaskStoreEvent.Update, onUpdate);

        await store.start(agent, ALICE);

        expect(agent.getTasks).toHaveBeenCalledWith(ALICE);
        expect(store.isAvailable).toBe(true);
        expect(store.tasks.map((task) => task.id)).toEqual(["1", "2"]);
        expect(store.openCount).toBe(1);
        expect(onUpdate).toHaveBeenCalled();
    });

    it("has no list without an agent", async () => {
        await store.start(undefined, ALICE);

        expect(store.isAvailable).toBe(false);
        expect(store.tasks).toEqual([]);
        expect(await store.addTasks([{ title: "Nothing", details: "" }])).toEqual([]);
    });

    it("keeps the list empty when the platform can't read it", async () => {
        agent.getTasks.mockResolvedValue({ ok: false, error: "unavailable" });

        await store.start(agent, ALICE);

        expect(store.tasks).toEqual([]);
    });

    it("adds new tasks at the top", async () => {
        await store.start(agent, ALICE);

        const added = await store.addTasks([{ title: "Create a ticket", details: "" }]);

        expect(agent.addTasks).toHaveBeenCalledWith(ALICE, [{ title: "Create a ticket", details: "" }]);
        expect(added.map((task) => task.title)).toEqual(["Create a ticket"]);
        expect(store.tasks.map((task) => task.id)).toEqual(["new-0", "1", "2"]);
    });

    it("adds nothing when the platform can't save the tasks", async () => {
        await store.start(agent, ALICE);
        agent.addTasks.mockResolvedValue({ ok: false, error: "invalid_request" });

        expect(await store.addTasks([{ title: "Create a ticket", details: "" }])).toEqual([]);
        expect(store.tasks).toHaveLength(2);
    });

    it("marks a task as done", async () => {
        await store.start(agent, ALICE);

        const done = store.setDone("1", true);
        expect(store.getTask("1")?.done).toBe(true);
        await done;

        expect(agent.updateTask).toHaveBeenCalledWith(ALICE, "1", { done: true });
        expect(store.openCount).toBe(0);
    });

    it("undoes marking a task as done when the platform can't save it", async () => {
        await store.start(agent, ALICE);
        agent.updateTask.mockResolvedValue({ ok: false, error: "not_found" });

        await store.setDone("1", true);

        expect(store.getTask("1")?.done).toBe(false);
    });

    it("removes a task, and brings it back when the platform can't remove it", async () => {
        await store.start(agent, ALICE);

        await store.deleteTask("1");
        expect(store.tasks.map((task) => task.id)).toEqual(["2"]);

        agent.deleteTask.mockResolvedValue({ ok: false, error: "unavailable" });
        await store.deleteTask("2");
        expect(store.tasks.map((task) => task.id)).toEqual(["2"]);
    });

    it("shows a task as running while the agent works on it, then its report", async () => {
        await store.start(agent, ALICE);
        let finish: (value: Awaited<ReturnType<AgentApi["runTask"]>>) => void = () => {};
        agent.runTask.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

        const run = store.runTask("1", "investigate");
        expect(store.getTask("1")?.run).toMatchObject({ mode: "investigate", state: "running" });
        // A second run of a running task is not started
        await store.runTask("1", "implement");
        expect(agent.runTask).toHaveBeenCalledTimes(1);

        finish({ ok: true, data: mkTask("1", { run: { mode: "investigate", state: "finished", startedAt: 1 } }) });
        await run;
        expect(store.getTask("1")?.run?.state).toBe("finished");
    });

    it("shows why the agent couldn't work on a task", async () => {
        await store.start(agent, ALICE);
        agent.runTask.mockResolvedValue({ ok: false, error: "no_workspace" });

        await store.runTask("1", "implement");

        expect(store.getTask("1")?.run).toMatchObject({ mode: "implement", state: "failed", error: "no_workspace" });
    });

    it("opens a task in the coding CLI of the platform", async () => {
        await store.start(agent, ALICE);
        agent.openTaskInCli.mockResolvedValue({ ok: true, data: undefined });

        expect(await store.openInCli("1", "/work/app", "Add a test")).toBeUndefined();

        expect(agent.openTaskInCli).toHaveBeenCalledWith(ALICE, "1", "/work/app", "Add a test");
    });

    it("says why a task couldn't be opened in the coding CLI", async () => {
        expect(await store.openInCli("1", "/work/app", "")).toBe("unavailable");

        await store.start(agent, ALICE);
        agent.openTaskInCli.mockResolvedValueOnce({ ok: false, error: "no_workspace" });
        expect(await store.openInCli("1", "/gone", "")).toBe("no_workspace");
        agent.openTaskInCli.mockRejectedValueOnce(new Error("IPC failed"));
        expect(await store.openInCli("1", "/work/app", "")).toBe("unavailable");
    });

    it("shows a failure when the platform throws", async () => {
        await store.start(agent, ALICE);
        agent.runTask.mockRejectedValue(new Error("IPC failed"));

        await store.runTask("1", "investigate");

        expect(store.getTask("1")?.run).toMatchObject({ state: "failed", error: "unavailable" });
    });
});
