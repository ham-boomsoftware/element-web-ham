/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import type {
    AgentErrorCode,
    AgentFileDiff,
    AgentNewTask,
    AgentResult,
    AgentTask,
    AgentTaskProgress,
    AgentTaskRunMode,
} from "shared-types";

import type { AgentApi } from "./AgentApi";

export enum AgentTaskStoreEvent {
    /** The list changed, or the store started or stopped */
    Update = "update",
}

type EventHandlerMap = {
    [AgentTaskStoreEvent.Update]: () => void;
};

/**
 * The user's to-do list: requests the agent found in chats (see {@link AgentTaskListener}), or that the user added.
 *
 * The list is kept by the platform's agent on this computer only, never on the homeserver. This store holds a copy
 * of it for the views, and changes it through the agent.
 */
export class AgentTaskStore extends TypedEventEmitter<AgentTaskStoreEvent, EventHandlerMap> {
    private static internalInstance?: AgentTaskStore;

    private agent?: AgentApi;
    private userId?: string;
    private list: AgentTask[] = [];
    private stopFollowingProgress?: () => void;

    public static get instance(): AgentTaskStore {
        AgentTaskStore.internalInstance ??= new AgentTaskStore();
        return AgentTaskStore.internalInstance;
    }

    /** Whether there is a to-do list: only on a platform with an agent */
    public get isAvailable(): boolean {
        return Boolean(this.agent);
    }

    /** The tasks, newest first */
    public get tasks(): readonly AgentTask[] {
        return this.list;
    }

    /** How many tasks are not done yet */
    public get openCount(): number {
        return this.list.filter((task) => !task.done).length;
    }

    /**
     * Read the to-do list of a user.
     * @param agent - The agent of the platform; without one, there is no list
     * @param userId - The Matrix user whose list to read
     */
    public async start(agent: AgentApi | undefined, userId: string): Promise<void> {
        this.stopFollowingProgress?.();
        this.stopFollowingProgress = undefined;
        this.agent = agent;
        this.userId = userId;
        this.list = [];
        this.emit(AgentTaskStoreEvent.Update);
        if (!agent) return;
        this.stopFollowingProgress = agent.onTaskProgress(this.onProgress);

        const result = await agent.getTasks(userId);
        // Another user may have logged in meanwhile
        if (this.agent !== agent || this.userId !== userId) return;
        if (result.ok) {
            this.list = result.data;
            this.emit(AgentTaskStoreEvent.Update);
        } else {
            logger.warn(`Could not read the to-do list: ${result.error}`, result.message);
        }
    }

    public stop(): void {
        this.stopFollowingProgress?.();
        this.stopFollowingProgress = undefined;
        this.agent = undefined;
        this.userId = undefined;
        this.list = [];
        this.emit(AgentTaskStoreEvent.Update);
    }

    /** Get a task by its ID */
    public getTask(taskId: string): AgentTask | undefined {
        return this.list.find((task) => task.id === taskId);
    }

    /**
     * Add tasks to the list.
     * @returns the added tasks; none if the platform couldn't save them
     */
    public async addTasks(tasks: AgentNewTask[]): Promise<AgentTask[]> {
        const { agent, userId } = this;
        if (!agent || !userId || tasks.length === 0) return [];
        const result = await agent.addTasks(userId, tasks);
        if (this.agent !== agent || this.userId !== userId) return [];
        if (!result.ok) {
            logger.warn(`Could not add to the to-do list: ${result.error}`, result.message);
            return [];
        }
        this.list = [...result.data, ...this.list];
        this.emit(AgentTaskStoreEvent.Update);
        return result.data;
    }

    /**
     * Mark a task as done, or as not done. The change shows straight away, and is undone if the platform can't
     * save it.
     */
    public async setDone(taskId: string, done: boolean): Promise<void> {
        const { agent, userId } = this;
        const task = this.getTask(taskId);
        if (!agent || !userId || !task || task.done === done) return;

        this.replace({ ...task, done });
        const result = await agent.updateTask(userId, taskId, { done });
        if (this.agent !== agent) return;
        if (result.ok) {
            this.replace(result.data);
        } else {
            logger.warn(`Could not change the task ${taskId}: ${result.error}`, result.message);
            const current = this.getTask(taskId);
            if (current) this.replace({ ...current, done: !done });
        }
    }

    /**
     * Remove a task from the list. It disappears straight away, and comes back if the platform can't remove it.
     */
    public async deleteTask(taskId: string): Promise<void> {
        const { agent, userId } = this;
        const index = this.list.findIndex((task) => task.id === taskId);
        if (!agent || !userId || index === -1) return;

        const task = this.list[index];
        this.list = this.list.filter((other) => other.id !== taskId);
        this.emit(AgentTaskStoreEvent.Update);
        const result = await agent.deleteTask(userId, taskId);
        if (this.agent !== agent || result.ok) return;
        logger.warn(`Could not remove the task ${taskId}: ${result.error}`, result.message);
        this.list = [...this.list.slice(0, index), task, ...this.list.slice(index)];
        this.emit(AgentTaskStoreEvent.Update);
    }

    /**
     * Let the agent work on a task in the workspace. The task shows as running straight away; when the agent is
     * done, it shows its report, or why it couldn't work on it.
     */
    public async runTask(taskId: string, mode: AgentTaskRunMode): Promise<void> {
        const { agent, userId } = this;
        const task = this.getTask(taskId);
        if (!agent || !userId || !task || task.run?.state === "running") return;

        const startedAt = Date.now();
        this.replace({ ...task, run: { mode, state: "running", startedAt, steps: [] } });
        const result = await agent.runTask(userId, taskId, mode).catch((e) => {
            logger.warn(`Could not run the task ${taskId}`, e);
            return { ok: false as const, error: "unavailable" as const, message: undefined };
        });
        if (this.agent !== agent) return;
        const current = this.getTask(taskId);
        if (!current) return;
        if (result.ok) {
            this.replace(result.data);
        } else {
            logger.warn(`Could not run the task ${taskId}: ${result.error}`, result.message);
            this.replace({
                ...current,
                run: { mode, state: "failed", startedAt, finishedAt: Date.now(), error: result.error },
            });
        }
    }

    /**
     * Open a task in the coding CLI of the settings, in a new terminal in a project folder.
     * @param instructions - What the user adds for the CLI, or ""
     * @returns why it couldn't be opened, or undefined if it was
     */
    public async openInCli(taskId: string, folder: string, instructions: string): Promise<AgentErrorCode | undefined> {
        const { agent, userId } = this;
        if (!agent || !userId) return "unavailable";
        const result = await agent.openTaskInCli(userId, taskId, folder, instructions).catch((e) => {
            logger.warn(`Could not open the task ${taskId} in the coding CLI`, e);
            return { ok: false as const, error: "unavailable" as const, message: undefined };
        });
        if (result.ok) return undefined;
        logger.warn(`Could not open the task ${taskId} in the coding CLI: ${result.error}`, result.message);
        return result.error;
    }

    /**
     * Get the changes the autopilot made on its branch for a task.
     * @returns the changes of each file, or why they couldn't be read
     */
    public async getDiff(taskId: string): Promise<AgentResult<AgentFileDiff[]>> {
        const { agent, userId } = this;
        if (!agent || !userId) return { ok: false, error: "unavailable" };
        const result = await agent.getTaskDiff(userId, taskId).catch((e) => {
            logger.warn(`Could not get the changes of the task ${taskId}`, e);
            return { ok: false as const, error: "unavailable" as const, message: undefined };
        });
        if (!result.ok) logger.warn(`Could not get the changes of the task ${taskId}: ${result.error}`, result.message);
        return result;
    }

    /**
     * Remove the worktree the autopilot did a task in. Its branch is kept if it has a commit.
     */
    public async removeWorktree(taskId: string): Promise<void> {
        const { agent, userId } = this;
        if (!agent || !userId) return;
        const result = await agent.removeTaskWorktree(userId, taskId);
        if (this.agent !== agent) return;
        if (result.ok) this.replace(result.data);
        else logger.warn(`Could not remove the worktree of the task ${taskId}: ${result.error}`, result.message);
    }

    /**
     * Open the worktree the autopilot did a task in with the file manager.
     * @returns why it couldn't be opened, or undefined if it was
     */
    public async openFolder(taskId: string): Promise<AgentErrorCode | undefined> {
        const { agent, userId } = this;
        if (!agent || !userId) return "unavailable";
        const result = await agent.openTaskFolder(userId, taskId);
        if (result.ok) return undefined;
        logger.warn(`Could not open the folder of the task ${taskId}: ${result.error}`, result.message);
        return result.error;
    }

    /** Show each step of the agent's work as it happens */
    private readonly onProgress = ({ userId, taskId, run }: AgentTaskProgress): void => {
        if (userId !== this.userId) return;
        const task = this.getTask(taskId);
        // A late step must not take back the end of a run
        if (!task || (task.run && task.run.startedAt === run.startedAt && task.run.state !== "running")) return;
        this.replace({ ...task, run });
    };

    private replace(task: AgentTask): void {
        this.list = this.list.map((other) => (other.id === task.id ? task : other));
        this.emit(AgentTaskStoreEvent.Update);
    }
}
