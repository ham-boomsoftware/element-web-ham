/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/
// This file contains types for the agent IPC API: the renderer asks the main process of Element Desktop for
// replies to direct messages in agent mode, and for reply suggestions in any chat. The main process holds the credentials and talks to the providers,
// so the credentials never reach the renderer.

/**
 * The AI providers an agent can use.
 * - `claude`: the Claude API, with an Anthropic API key.
 * - `copilot`: GitHub Copilot through the Copilot SDK, with a GitHub token of a Copilot subscriber.
 */
export type AgentProvider = "claude" | "copilot";

/**
 * The settings of the agent, kept in the local store of Element Desktop.
 */
export interface AgentSettings {
    /** The provider that writes the replies */
    provider: AgentProvider;
    /** The model to use, or undefined for the default model of the provider */
    model?: string;
    /** Extra instructions from the user, added to the system prompt */
    instructions: string;
    /** Whether replies are suggested above the composer of every chat */
    replySuggestions: boolean;
    /**
     * Whether the agent looks for requests to the user in new messages and adds them to the to-do list: every
     * message of a direct chat, and messages of group chats that mention the user.
     */
    taskDetection: boolean;
    /** Whether the agent looks into each new task in the workspace by itself, without changing anything */
    autoInvestigate: boolean;
    /** The local folder of the project the agent works on for tasks, or undefined if none is set */
    workspacePath?: string;
    /** The coding CLI that is opened in a terminal to do a task */
    codingCli: AgentCodingCli;
}

/**
 * The coding CLIs the user can do a task with, in a terminal of their own.
 * - `claude`: Claude Code.
 * - `copilot`: GitHub Copilot CLI.
 */
export type AgentCodingCli = "claude" | "copilot";

/**
 * The settings of the agent and which providers have a stored credential.
 */
export interface AgentStatus extends AgentSettings {
    /** Whether a credential is stored for each provider */
    connected: Record<AgentProvider, boolean>;
    /** The project folders tasks were last opened in with the coding CLI, most recent first */
    recentProjects: string[];
}

/**
 * One message of the conversation the agent replies to.
 * `assistant` is a message of the user the agent writes for, `user` a message of their chat partner.
 */
export interface AgentTurn {
    role: "user" | "assistant";
    text: string;
}

/**
 * A request for the reply to a direct message.
 */
export interface AgentReplyRequest {
    /** The display name of the user the agent writes for */
    ownName: string;
    /** The display name of their chat partner */
    partnerName: string;
    /** The latest messages of the conversation, oldest first, ending with a message of the partner */
    turns: AgentTurn[];
}

/**
 * One message of a chat the agent suggests replies for.
 */
export interface AgentSuggestionMessage {
    /** The display name of the sender */
    sender: string;
    /** Whether the user the agent writes for sent it */
    own: boolean;
    text: string;
}

/**
 * A request for replies the user could send next in a chat, direct or group.
 */
export interface AgentSuggestionsRequest {
    /** The display name of the user the agent writes for */
    ownName: string;
    /** The name of the chat */
    chatName: string;
    /** Whether the chat is a direct message */
    isDirect: boolean;
    /** The latest messages of the chat, oldest first, ending with a message of someone else */
    messages: AgentSuggestionMessage[];
}

/**
 * A request to find tasks for the user in the latest messages of a chat.
 */
export interface AgentTaskDetectionRequest {
    /** The display name of the user the tasks are for */
    ownName: string;
    /** The name of the chat */
    chatName: string;
    /** Whether the chat is a direct message */
    isDirect: boolean;
    /** The latest messages of the chat, oldest first, for context */
    messages: AgentSuggestionMessage[];
    /** How many of the last messages are new; only these are searched for tasks */
    newCount: number;
    /** The titles of the open tasks, so that a task already on the list is not added again */
    openTasks: string[];
}

/**
 * A task the agent found in a chat.
 */
export interface AgentDetectedTask {
    /** A short title, as an instruction */
    title: string;
    /** What exactly is asked, with the context needed to do it */
    details: string;
}

/**
 * Where a task came from: the message that asked for it.
 */
export interface AgentTaskSource {
    roomId: string;
    /** The name of the chat when the task was found */
    roomName: string;
    /** The display name of who asked */
    sender: string;
    /** The message that asked for it, if known */
    eventId?: string;
}

/**
 * How the agent works on a task.
 * - `investigate`: it reads the workspace and reports what to do, with a ticket text, without changing anything.
 * - `implement`: it changes files in the workspace to do the task. It never commits.
 */
export type AgentTaskRunMode = "investigate" | "implement";

/**
 * The latest work of the agent on a task.
 */
export interface AgentTaskRun {
    mode: AgentTaskRunMode;
    state: "running" | "finished" | "failed";
    startedAt: number;
    finishedAt?: number;
    /** The report of the agent: what it found, or what it changed */
    summary?: string;
    /** The files the agent changed, relative to the workspace */
    changedFiles?: string[];
    /** Why the run failed */
    error?: AgentErrorCode;
}

/**
 * An entry of the user's to-do list: something someone asked them to do, or that they added themselves.
 */
export interface AgentTask {
    id: string;
    title: string;
    details: string;
    done: boolean;
    createdAt: number;
    /** The message that asked for it; undefined for a task the user added */
    source?: AgentTaskSource;
    /** The latest work of the agent on it */
    run?: AgentTaskRun;
}

/**
 * The fields of a new task.
 */
export type AgentNewTask = Pick<AgentTask, "title" | "details" | "source">;

/**
 * The fields of a task the user can change.
 */
export type AgentTaskChanges = Partial<Pick<AgentTask, "title" | "details" | "done">>;

/**
 * A model a provider offers.
 */
export interface AgentModel {
    id: string;
    /** Name for display */
    name: string;
}

/**
 * Why an agent IPC command failed.
 * - `not_connected`: no credential is stored for the provider.
 * - `invalid_credential`: the provider rejected the credential.
 * - `rate_limited`: the provider asks to slow down, or the plan's allowance is used up.
 * - `refused`: the model declined to write a reply.
 * - `disabled`: the user turned the feature off in the settings.
 * - `no_workspace`: no workspace is set, or its folder doesn't exist.
 * - `not_found`: the task doesn't exist.
 * - `busy`: the agent is already working on the task.
 * - `unavailable`: the provider could not be reached or failed.
 * - `invalid_request`: the command was called with invalid arguments.
 */
export type AgentErrorCode =
    | "not_connected"
    | "invalid_credential"
    | "rate_limited"
    | "refused"
    | "disabled"
    | "no_workspace"
    | "not_found"
    | "busy"
    | "unavailable"
    | "invalid_request";

/**
 * Result of an agent IPC command: the data, or why it failed with the provider's message if any.
 */
export type AgentResult<T> = { ok: true; data: T } | { ok: false; error: AgentErrorCode; message?: string };
