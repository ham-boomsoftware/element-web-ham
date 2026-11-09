/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import {
    BaseViewModel,
    type AgentTodoFilter,
    type AgentTodoItem,
    type AgentTodoRunError,
    type AgentTodoRunMode,
    type AgentTodoViewModel as AgentTodoViewModelInterface,
    type AgentTodoViewSnapshot,
} from "@element-hq/web-shared-components";
import type { AgentErrorCode, AgentTask } from "shared-types";

import type { AgentApi } from "../../agent/AgentApi";
import { type AgentTaskStore, AgentTaskStoreEvent } from "../../agent/AgentTaskStore";
import { formatDate } from "../../DateUtils";

export interface AgentTodoViewModelProps {
    /** The to-do list */
    store: AgentTaskStore;
    /** The agent of the platform, which knows whether it can work on tasks */
    agent: AgentApi;
    /** Open a chat at a message */
    onOpenChat: (roomId: string, eventId?: string) => void;
}

/** Turn the error of the platform into one the to-do list can show */
export function toRunError(error: AgentErrorCode | undefined): AgentTodoRunError {
    switch (error) {
        case "no_workspace":
        case "not_connected":
        case "rate_limited":
            return error;
        default:
            return "unknown";
    }
}

/** A task as the to-do list shows it */
export function toTodoItem(task: AgentTask): AgentTodoItem {
    return {
        id: task.id,
        title: task.title,
        details: task.details,
        done: task.done,
        sender: task.source?.sender || undefined,
        chatName: task.source?.roomName || undefined,
        date: formatDate(new Date(task.createdAt)),
        canOpenChat: Boolean(task.source?.roomId),
        run: task.run && {
            mode: task.run.mode,
            state: task.run.state,
            summary: task.run.summary,
            changedFiles: task.run.changedFiles ?? [],
            error: task.run.state === "failed" ? toRunError(task.run.error) : undefined,
        },
    };
}

/**
 * View model of the to-do list: shows the tasks of {@link AgentTaskStore} and changes them there.
 */
export class AgentTodoViewModel
    extends BaseViewModel<AgentTodoViewSnapshot, AgentTodoViewModelProps>
    implements AgentTodoViewModelInterface
{
    public constructor(props: AgentTodoViewModelProps) {
        super(props, {
            ...AgentTodoViewModel.computeList(props.store, "open"),
            canRun: false,
            projects: [],
            cli: "claude",
        });
        this.disposables.trackListener(props.store, AgentTaskStoreEvent.Update, this.onStoreUpdate);
        void this.loadStatus();
    }

    /** The parts of the snapshot that come from the list */
    private static computeList(
        store: AgentTaskStore,
        filter: AgentTodoFilter,
    ): Pick<AgentTodoViewSnapshot, "filter" | "items" | "openCount" | "doneCount"> {
        const tasks = store.tasks;
        const openCount = tasks.filter((task) => !task.done).length;
        return {
            filter,
            items: tasks.filter((task) => task.done === (filter === "done")).map(toTodoItem),
            openCount,
            doneCount: tasks.length - openCount,
        };
    }

    /**
     * Read what the agent can do: whether it can look into tasks, as a provider is connected and a workspace is
     * set, the project folders to do a task in, and the coding CLI.
     */
    private async loadStatus(): Promise<void> {
        try {
            const status = await this.props.agent.getStatus();
            if (this.isDisposed) return;
            // The workspace of the settings is offered too, after the folders used recently
            const projects = withoutDuplicates([
                ...status.recentProjects,
                ...(status.workspacePath ? [status.workspacePath] : []),
            ]);
            this.snapshot.merge({
                canRun: Boolean(status.connected[status.provider] && status.workspacePath),
                projects,
                project: projects[0],
                cli: status.codingCli,
            });
        } catch (e) {
            logger.warn("Could not read the status of the agent", e);
        }
    }

    private readonly onStoreUpdate = (): void => {
        this.snapshot.merge(AgentTodoViewModel.computeList(this.props.store, this.snapshot.current.filter));
    };

    public setFilter = (filter: AgentTodoFilter): void => {
        this.snapshot.merge(AgentTodoViewModel.computeList(this.props.store, filter));
    };

    public addTask = (title: string): void => {
        void this.props.store.addTasks([{ title, details: "" }]);
    };

    public setDone = (id: string, done: boolean): void => {
        void this.props.store.setDone(id, done);
    };

    public deleteTask = (id: string): void => {
        void this.props.store.deleteTask(id);
    };

    public openChat = (id: string): void => {
        const source = this.props.store.getTask(id)?.source;
        if (source) this.props.onOpenChat(source.roomId, source.eventId);
    };

    public runTask = (id: string, mode: AgentTodoRunMode): void => {
        void this.props.store.runTask(id, mode);
    };

    public selectProject = (project: string): void => {
        this.snapshot.merge({ project });
    };

    public chooseProject = (): void => {
        void (async () => {
            const result = await this.props.agent.pickFolder().catch((e) => {
                logger.warn("Could not choose a project folder", e);
                return undefined;
            });
            // Nothing changes when the user cancelled the folder dialog
            if (this.isDisposed || !result?.ok || !result.data) return;
            const project = result.data;
            this.snapshot.merge({ projects: withoutDuplicates([project, ...this.snapshot.current.projects]), project });
        })();
    };

    public openInCli = (id: string, instructions: string): void => {
        const { project } = this.snapshot.current;
        if (!project) return;
        this.snapshot.merge({ launch: { id, state: "opening" } });
        void (async () => {
            const error = await this.props.store.openInCli(id, project, instructions);
            if (this.isDisposed) return;
            if (error) {
                this.snapshot.merge({
                    launch: { id, state: "failed", error: error === "no_workspace" ? "folder_missing" : "unknown" },
                });
                return;
            }
            // The folder that was just used comes first next time
            this.snapshot.merge({
                launch: { id, state: "opened" },
                projects: withoutDuplicates([project, ...this.snapshot.current.projects]),
            });
        })();
    };
}

/** The folders without repeats, keeping the first of each; Windows paths differ only in case */
function withoutDuplicates(folders: string[]): string[] {
    const seen = new Set<string>();
    return folders.filter((folder) => {
        const key = folder.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
