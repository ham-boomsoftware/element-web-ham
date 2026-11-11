/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type {
    AgentDetectedTask,
    AgentModel,
    AgentNewTask,
    AgentProvider,
    AgentReplyRequest,
    AgentResult,
    AgentRoomRule,
    AgentRoomRules,
    AgentSettings,
    AgentStatus,
    AgentSuggestionsRequest,
    AgentTask,
    AgentTaskChanges,
    AgentTaskDetectionRequest,
    AgentTaskRunMode,
} from "shared-types";

/**
 * Access to the agent that follows the rules the user set for rooms, replies in the direct messages set to reply
 * automatically, suggests replies in any chat, and keeps the user's to-do list. The platform holds the credentials,
 * the room rules and the list and talks to the AI providers; see {@link BasePlatform.agent}.
 */
export interface AgentApi {
    /** Get the settings of the agent and which providers are connected */
    getStatus(): Promise<AgentStatus>;
    /** Change some of the settings */
    setSettings(changes: Partial<AgentSettings>): Promise<AgentResult<AgentSettings>>;
    /** Check a credential with its provider and store it */
    connect(provider: AgentProvider, credential: string): Promise<AgentResult<void>>;
    /** Forget the credential of a provider */
    disconnect(provider: AgentProvider): Promise<AgentResult<void>>;
    /** List the models a connected provider offers */
    listModels(provider: AgentProvider): Promise<AgentResult<AgentModel[]>>;
    /** Get the rules of a Matrix user's rooms */
    getRoomRules(userId: string): Promise<AgentResult<AgentRoomRules>>;
    /**
     * Set what the agent does in a room, or remove the rule with null so that the room follows the settings. The
     * rules are kept by the platform, on this computer only.
     * @returns the rules of the user's rooms afterwards
     */
    setRoomRule(userId: string, roomId: string, rule: AgentRoomRule | null): Promise<AgentResult<AgentRoomRules>>;
    /** Write the next message of the user in a direct message */
    generateReply(request: AgentReplyRequest): Promise<AgentResult<string>>;
    /** Suggest replies the user could send next in a chat */
    generateSuggestions(request: AgentSuggestionsRequest): Promise<AgentResult<string[]>>;
    /**
     * Let the user choose the workspace, the folder of the project the agent works on for tasks, and save it.
     * @returns the chosen folder, or undefined if the user cancelled
     */
    pickWorkspace(): Promise<AgentResult<string | undefined>>;
    /** Get the to-do list of a Matrix user, newest first */
    getTasks(userId: string): Promise<AgentResult<AgentTask[]>>;
    /**
     * Add tasks to the to-do list of a Matrix user.
     * @returns the added tasks
     */
    addTasks(userId: string, tasks: AgentNewTask[]): Promise<AgentResult<AgentTask[]>>;
    /** Change the title, description or state of a task */
    updateTask(userId: string, taskId: string, changes: AgentTaskChanges): Promise<AgentResult<AgentTask>>;
    /** Remove a task from the to-do list */
    deleteTask(userId: string, taskId: string): Promise<AgentResult<void>>;
    /** Find requests to the user in the new messages of a chat */
    detectTasks(request: AgentTaskDetectionRequest): Promise<AgentResult<AgentDetectedTask[]>>;
    /**
     * Let the agent work on a task in the workspace. It never commits.
     * @returns the task with the finished or failed run
     */
    runTask(userId: string, taskId: string, mode: AgentTaskRunMode): Promise<AgentResult<AgentTask>>;
    /**
     * Let the user choose a project folder, without changing the settings.
     * @returns the chosen folder, or undefined if the user cancelled
     */
    pickFolder(): Promise<AgentResult<string | undefined>>;
    /**
     * Open a task in the coding CLI of the settings, in a new terminal in a project folder, for the user to do it
     * together with the CLI.
     * @param instructions - What the user adds for the CLI, or ""
     */
    openTaskInCli(userId: string, taskId: string, folder: string, instructions: string): Promise<AgentResult<void>>;
}
