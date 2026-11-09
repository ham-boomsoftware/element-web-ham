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
        super(props, AgentTodoViewModel.computeSnapshot(props.store, "open", false));
        this.disposables.trackListener(props.store, AgentTaskStoreEvent.Update, this.onStoreUpdate);
        void this.checkCanRun();
    }

    private static computeSnapshot(
        store: AgentTaskStore,
        filter: AgentTodoFilter,
        canRun: boolean,
    ): AgentTodoViewSnapshot {
        const tasks = store.tasks;
        const openCount = tasks.filter((task) => !task.done).length;
        return {
            filter,
            items: tasks.filter((task) => task.done === (filter === "done")).map(toTodoItem),
            openCount,
            doneCount: tasks.length - openCount,
            canRun,
        };
    }

    /** Find out whether the agent can work on tasks: a provider is connected and a workspace is set */
    private async checkCanRun(): Promise<void> {
        try {
            const status = await this.props.agent.getStatus();
            if (this.isDisposed) return;
            this.snapshot.merge({ canRun: Boolean(status.connected[status.provider] && status.workspacePath) });
        } catch (e) {
            logger.warn("Could not read the status of the agent", e);
        }
    }

    private readonly onStoreUpdate = (): void => {
        const { filter, canRun } = this.snapshot.current;
        this.snapshot.set(AgentTodoViewModel.computeSnapshot(this.props.store, filter, canRun));
    };

    public setFilter = (filter: AgentTodoFilter): void => {
        this.snapshot.set(AgentTodoViewModel.computeSnapshot(this.props.store, filter, this.snapshot.current.canRun));
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
}
