/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import {
    BaseViewModel,
    type AgentTodoBranch,
    type AgentTodoFilter,
    type AgentTodoItem,
    type AgentTodoRunError,
    type AgentTodoRunMode,
    type AgentTodoViewModel as AgentTodoViewModelInterface,
    type AgentTodoViewSnapshot,
} from "@element-hq/web-shared-components";
import type { AgentErrorCode, AgentRunBranch, AgentTask } from "shared-types";

import type { AgentApi } from "../../agent/AgentApi";
import { type AgentTaskStore, AgentTaskStoreEvent } from "../../agent/AgentTaskStore";
import { formatDate, formatFullTime } from "../../DateUtils";
import { _t } from "../../languageHandler";

export interface AgentTodoViewModelProps {
    /** The to-do list */
    store: AgentTaskStore;
    /** The agent of the platform, which knows whether it can work on tasks */
    agent: AgentApi;
    /** Open a chat at a message */
    onOpenChat: (roomId: string, eventId?: string) => void;
    /** Send a message to a chat, as a reply to a message if there is one; rejects if it couldn't be sent */
    onSendToChat: (roomId: string, eventId: string | undefined, text: string) => Promise<void>;
}

/** How long the summary in a report to a chat may be */
const MAX_REPORT_SUMMARY = 600;

/** Turn the error of the platform into one the to-do list can show */
export function toRunError(error: AgentErrorCode | undefined): AgentTodoRunError {
    switch (error) {
        case "no_workspace":
        case "no_repository":
        case "not_connected":
        case "rate_limited":
            return error;
        default:
            return "unknown";
    }
}

/** The branch of the autopilot as the to-do list shows it */
function toTodoBranch(branch: AgentRunBranch): AgentTodoBranch {
    return {
        name: branch.name,
        base: branch.base,
        commit: branch.commit?.slice(0, 7),
        pushed: branch.pushed,
        pushError: branch.pushError,
        pullRequestUrl: branch.pushed ? branch.pullRequestUrl : undefined,
        hasWorktree: Boolean(branch.worktreePath),
    };
}

/**
 * What to tell the chat a task came from about the agent's work, for the user to change before sending.
 * @returns the text, or undefined if there is nothing to tell or no chat to tell it
 */
export function buildChatReport(task: AgentTask): string | undefined {
    const run = task.run;
    if (!task.source?.roomId || run?.state !== "finished") return undefined;
    const lines = [_t("agent_todo_list|chat_report_done", { title: task.title })];
    const summary = run.summary?.trim();
    if (summary) {
        lines.push(
            "",
            summary.length > MAX_REPORT_SUMMARY ? `${summary.slice(0, MAX_REPORT_SUMMARY).trimEnd()}…` : summary,
        );
    }
    const branch = run.branch;
    if (branch?.commit) {
        lines.push("", _t("agent_todo_list|chat_report_branch", { branch: branch.name }));
        if (branch.pushed && branch.pullRequestUrl) {
            lines.push(_t("agent_todo_list|chat_report_pull_request", { url: branch.pullRequestUrl }));
        }
    }
    return lines.join("\n");
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
            steps: (task.run.steps ?? []).map((step) => ({
                kind: step.kind,
                text: step.text,
                time: formatFullTime(new Date(step.at)),
                failed: Boolean(step.failed),
            })),
            branch: task.run.branch && toTodoBranch(task.run.branch),
        },
        chatReport: buildChatReport(task),
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
        // The changes shown are out of date once the autopilot works on the task again
        const { diff } = this.snapshot.current;
        if (diff && this.props.store.getTask(diff.id)?.run?.state === "running")
            this.snapshot.merge({ diff: undefined });
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

    public toggleDiff = (id: string): void => {
        if (this.snapshot.current.diff?.id === id) {
            this.snapshot.merge({ diff: undefined });
            return;
        }
        this.snapshot.merge({ diff: { id, state: "loading", files: [] } });
        void (async () => {
            const result = await this.props.store.getDiff(id);
            // Only if these changes are still the ones asked for
            if (this.isDisposed || this.snapshot.current.diff?.id !== id) return;
            this.snapshot.merge({
                diff: result.ok ? { id, state: "loaded", files: result.data } : { id, state: "failed", files: [] },
            });
        })();
    };

    public openWorktree = (id: string): void => {
        void this.props.store.openFolder(id);
    };

    public continueInCli = (id: string): void => {
        const folder = this.props.store.getTask(id)?.run?.branch?.worktreePath;
        if (folder) void this.props.store.openInCli(id, folder, "");
    };

    public removeWorktree = (id: string): void => {
        if (this.snapshot.current.diff?.id === id) this.snapshot.merge({ diff: undefined });
        void this.props.store.removeWorktree(id);
    };

    public reportToChat = (id: string, text: string): void => {
        const source = this.props.store.getTask(id)?.source;
        if (!source?.roomId) return;
        this.snapshot.merge({ chatReport: { id, state: "sending" } });
        void (async () => {
            let sent = true;
            try {
                await this.props.onSendToChat(source.roomId, source.eventId, text);
            } catch (e) {
                logger.warn(`Could not tell the chat of the task ${id}`, e);
                sent = false;
            }
            if (this.isDisposed) return;
            this.snapshot.merge({ chatReport: { id, state: sent ? "sent" : "failed" } });
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
