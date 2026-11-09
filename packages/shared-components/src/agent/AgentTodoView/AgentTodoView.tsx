/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useState } from "react";
import { Button, CheckboxInput, Text } from "@vector-im/compound-web";
import AiIcon from "@vector-im/compound-design-tokens/assets/web/icons/ai";

import { type ViewModel, useViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import styles from "./AgentTodoView.module.css";

/**
 * Which tasks are shown: those still to do, or those done.
 */
export type AgentTodoFilter = "open" | "done";

/**
 * How the agent works on a task.
 * - `investigate`: it looks into the project and reports what to do, with a ticket, without changing anything.
 * - `implement`: it changes files of the project to do the task, without committing.
 */
export type AgentTodoRunMode = "investigate" | "implement";

/**
 * Why the agent couldn't work on a task.
 * - `no_workspace`: no project folder is set in the agent settings.
 * - `not_connected`: no AI provider is connected.
 * - `rate_limited`: the provider asks to slow down, or the plan's allowance is used up.
 * - `unknown`: anything else.
 */
export type AgentTodoRunError = "no_workspace" | "not_connected" | "rate_limited" | "unknown";

/**
 * The coding CLI that "Do it" opens in a terminal: Claude Code or GitHub Copilot CLI.
 */
export type AgentTodoCli = "claude" | "copilot";

/**
 * Opening a task in the coding CLI.
 * - `opening`: the terminal is being opened.
 * - `opened`: the terminal is open; the user carries on there.
 * - `failed`: it couldn't be opened, see `error`.
 */
export interface AgentTodoLaunch {
    /** The task that is opened */
    id: string;
    state: "opening" | "opened" | "failed";
    /**
     * Why it couldn't be opened.
     * - `folder_missing`: the project folder doesn't exist.
     * - `unknown`: anything else, most likely that the CLI isn't installed.
     */
    error?: "folder_missing" | "unknown";
}

/**
 * The latest work of the agent on a task.
 */
export interface AgentTodoRun {
    mode: AgentTodoRunMode;
    state: "running" | "finished" | "failed";
    /** The report of the agent, or the provider's message when it failed */
    summary?: string;
    /** The files the agent changed, relative to the project folder */
    changedFiles: string[];
    /** Why it failed */
    error?: AgentTodoRunError;
}

/**
 * A task of the to-do list.
 */
export interface AgentTodoItem {
    id: string;
    title: string;
    /** What exactly is asked, or "" */
    details: string;
    done: boolean;
    /** Who asked, if the task came from a chat */
    sender?: string;
    /** The chat it came from */
    chatName?: string;
    /** When it was added, ready for display */
    date: string;
    /** Whether the chat it came from can be opened */
    canOpenChat: boolean;
    /** The latest work of the agent on it */
    run?: AgentTodoRun;
}

export interface AgentTodoViewSnapshot {
    /** Which tasks are shown */
    filter: AgentTodoFilter;
    /** The tasks of the filter, newest first */
    items: AgentTodoItem[];
    /** How many tasks are still to do */
    openCount: number;
    /** How many tasks are done */
    doneCount: number;
    /** Whether the agent can look into tasks: a provider is connected and a project folder is set */
    canRun: boolean;
    /** The project folders to choose from for "Do it", most recent first */
    projects: string[];
    /** The chosen project folder, if any */
    project?: string;
    /** The coding CLI that "Do it" opens */
    cli: AgentTodoCli;
    /** The latest opening of a task in the coding CLI */
    launch?: AgentTodoLaunch;
}

export interface AgentTodoViewActions {
    /** Show the open or the done tasks */
    setFilter: (filter: AgentTodoFilter) => void;
    /** Add a task the user wrote */
    addTask: (title: string) => void;
    /** Mark a task as done or not done */
    setDone: (id: string, done: boolean) => void;
    /** Remove a task */
    deleteTask: (id: string) => void;
    /** Open the chat a task came from, at the message that asked for it */
    openChat: (id: string) => void;
    /** Let the agent work on a task */
    runTask: (id: string, mode: AgentTodoRunMode) => void;
    /** Choose one of the project folders */
    selectProject: (project: string) => void;
    /** Let the user choose another project folder in a dialog */
    chooseProject: () => void;
    /** Open a task in the coding CLI, in the chosen project folder, with the user's own prompt */
    openInCli: (id: string, instructions: string) => void;
}

/**
 * The view model of {@link AgentTodoView}.
 */
export type AgentTodoViewModel = ViewModel<AgentTodoViewSnapshot, AgentTodoViewActions>;

export interface AgentTodoViewProps {
    /** The view model of the to-do list */
    vm: AgentTodoViewModel;
}

/**
 * The user's to-do list: what others asked them to do in chats, collected by the agent, and what they added
 * themselves. The agent can look into a task in the user's project folder, and "Do it" opens the task in a
 * coding CLI in a terminal, in a project folder the user chooses, with a prompt of their own.
 *
 * @example
 * ```tsx
 * <AgentTodoView vm={agentTodoViewModel} />
 * ```
 */
export function AgentTodoView({ vm }: Readonly<AgentTodoViewProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const snapshot = useViewModel(vm);
    const { filter, items, openCount, doneCount, canRun } = snapshot;
    const [draft, setDraft] = useState("");

    const filters: { value: AgentTodoFilter; label: string }[] = [
        { value: "open", label: _t("agent_todo|filter_open", { number: openCount }) },
        { value: "done", label: _t("agent_todo|filter_done", { number: doneCount }) },
    ];

    return (
        <Flex direction="column" gap="var(--cpd-space-4x)" className={styles.view}>
            <Flex role="group" aria-label={_t("agent_todo|filter_label")} gap="var(--cpd-space-2x)">
                {filters.map(({ value, label }) => (
                    <button
                        key={value}
                        type="button"
                        className={styles.filter}
                        aria-pressed={filter === value}
                        onClick={() => vm.setFilter(value)}
                    >
                        {label}
                    </button>
                ))}
            </Flex>

            <form
                className={styles.addForm}
                onSubmit={(ev) => {
                    ev.preventDefault();
                    if (!draft.trim()) return;
                    vm.addTask(draft.trim());
                    setDraft("");
                }}
            >
                <input
                    className={styles.addInput}
                    value={draft}
                    aria-label={_t("agent_todo|add_label")}
                    placeholder={_t("agent_todo|add_placeholder")}
                    onChange={(ev) => setDraft(ev.currentTarget.value)}
                />
                <Button type="submit" kind="primary" size="md" disabled={!draft.trim()}>
                    {_t("agent_todo|add")}
                </Button>
            </form>

            {!canRun && (
                <Text size="sm" className={styles.hint}>
                    {_t("agent_todo|no_workspace_hint")}
                </Text>
            )}

            {items.length === 0 ? (
                <Text size="md" className={styles.empty}>
                    {filter === "open" ? _t("agent_todo|empty_open") : _t("agent_todo|empty_done")}
                </Text>
            ) : (
                <ul className={styles.list} aria-label={_t("agent_todo|list_label")}>
                    {items.map((item) => (
                        <AgentTodoEntry key={item.id} item={item} snapshot={snapshot} vm={vm} />
                    ))}
                </ul>
            )}
        </Flex>
    );
}

interface AgentTodoEntryProps {
    item: AgentTodoItem;
    snapshot: AgentTodoViewSnapshot;
    vm: AgentTodoViewModel;
}

/** One task of the list, with its actions and the latest report of the agent */
function AgentTodoEntry({ item, snapshot, vm }: Readonly<AgentTodoEntryProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { id, title, details, done, sender, chatName, date, canOpenChat, run } = item;
    const isRunning = run?.state === "running";
    const [isLaunchOpen, setLaunchOpen] = useState(false);
    const origin =
        sender && chatName
            ? _t("agent_todo|from_chat", { sender, chat: chatName, date })
            : _t("agent_todo|added_by_you", { date });

    return (
        <li className={styles.item} data-done={done}>
            <Flex gap="var(--cpd-space-3x)" align="start">
                <CheckboxInput
                    className={styles.checkbox}
                    checked={done}
                    aria-label={done ? _t("agent_todo|mark_open", { title }) : _t("agent_todo|mark_done", { title })}
                    onChange={(ev) => vm.setDone(id, ev.currentTarget.checked)}
                />
                <Flex direction="column" gap="var(--cpd-space-1x)" className={styles.content}>
                    <Text size="md" weight="semibold" className={styles.title}>
                        {title}
                    </Text>
                    <Text size="sm" className={styles.meta}>
                        {origin}
                    </Text>
                    {details && (
                        <Text size="sm" className={styles.details}>
                            {details}
                        </Text>
                    )}

                    <Flex gap="var(--cpd-space-2x)" wrap="wrap" className={styles.actions}>
                        {canOpenChat && (
                            <Button kind="tertiary" size="md" onClick={() => vm.openChat(id)}>
                                {_t("agent_todo|open_chat")}
                            </Button>
                        )}
                        {!done && (
                            <>
                                <Button
                                    kind="secondary"
                                    size="md"
                                    disabled={!snapshot.canRun || isRunning}
                                    onClick={() => vm.runTask(id, "investigate")}
                                >
                                    {_t("agent_todo|investigate")}
                                </Button>
                                <Button
                                    kind="secondary"
                                    size="md"
                                    aria-expanded={isLaunchOpen}
                                    onClick={() => setLaunchOpen(!isLaunchOpen)}
                                >
                                    {_t("agent_todo|implement")}
                                </Button>
                            </>
                        )}
                        <Button kind="tertiary" size="md" destructive onClick={() => vm.deleteTask(id)}>
                            {_t("action|delete")}
                        </Button>
                    </Flex>

                    {isLaunchOpen && !done && (
                        <AgentTodoLaunchForm
                            id={id}
                            snapshot={snapshot}
                            vm={vm}
                            onCancel={() => setLaunchOpen(false)}
                        />
                    )}
                    {run && <AgentTodoRunReport run={run} />}
                </Flex>
            </Flex>
        </li>
    );
}

/** The value of the option that opens the folder dialog */
const OTHER_PROJECT = "\0other";

interface AgentTodoLaunchFormProps {
    id: string;
    snapshot: AgentTodoViewSnapshot;
    vm: AgentTodoViewModel;
    onCancel: () => void;
}

/** Choose the project folder and write a prompt, then open the task in the coding CLI */
function AgentTodoLaunchForm({ id, snapshot, vm, onCancel }: Readonly<AgentTodoLaunchFormProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { projects, project, cli, launch } = snapshot;
    const [instructions, setInstructions] = useState("");
    const ownLaunch = launch?.id === id ? launch : undefined;
    const projectId = `mx_AgentTodo_project_${id}`;
    const instructionsId = `mx_AgentTodo_instructions_${id}`;
    const launchErrors: Record<NonNullable<AgentTodoLaunch["error"]>, string> = {
        folder_missing: _t("agent_todo|launch_error_folder"),
        unknown: _t("agent_todo|launch_error_unknown"),
    };

    return (
        <form
            className={styles.launch}
            aria-label={_t("agent_todo|launch_label")}
            onSubmit={(ev) => {
                ev.preventDefault();
                if (project) vm.openInCli(id, instructions.trim());
            }}
        >
            <label className={styles.launchLabel} htmlFor={projectId}>
                {_t("agent_todo|project")}
            </label>
            {projects.length > 0 ? (
                <select
                    id={projectId}
                    className={styles.control}
                    value={project ?? ""}
                    onChange={(ev) => {
                        const value = ev.currentTarget.value;
                        if (value === OTHER_PROJECT) vm.chooseProject();
                        else vm.selectProject(value);
                    }}
                >
                    {projects.map((folder) => (
                        <option key={folder} value={folder}>
                            {folder}
                        </option>
                    ))}
                    <option value={OTHER_PROJECT}>{_t("agent_todo|project_other")}</option>
                </select>
            ) : (
                <Flex align="center" justify="space-between" gap="var(--cpd-space-3x)">
                    <Text id={projectId} size="sm" className={styles.hint}>
                        {_t("agent_todo|project_none")}
                    </Text>
                    <Button type="button" kind="secondary" size="md" onClick={vm.chooseProject}>
                        {_t("agent_todo|project_choose")}
                    </Button>
                </Flex>
            )}

            <label className={styles.launchLabel} htmlFor={instructionsId}>
                {_t("agent_todo|instructions_label")}
            </label>
            <textarea
                id={instructionsId}
                className={styles.control}
                rows={3}
                value={instructions}
                placeholder={_t("agent_todo|instructions_placeholder")}
                onChange={(ev) => setInstructions(ev.currentTarget.value)}
            />

            <Flex gap="var(--cpd-space-2x)" justify="end">
                <Button type="button" kind="tertiary" size="md" onClick={onCancel}>
                    {_t("action|cancel")}
                </Button>
                <Button type="submit" kind="primary" size="md" disabled={!project || ownLaunch?.state === "opening"}>
                    {cli === "claude" ? _t("agent_todo|open_claude") : _t("agent_todo|open_copilot")}
                </Button>
            </Flex>

            {ownLaunch?.state === "opened" && (
                <Text size="sm" role="status" className={styles.hint}>
                    {_t("agent_todo|launch_opened")}
                </Text>
            )}
            {ownLaunch?.state === "failed" && (
                <Text size="sm" role="alert" className={styles.launchError}>
                    {launchErrors[ownLaunch.error ?? "unknown"]}
                </Text>
            )}
        </form>
    );
}

/** What the agent did on a task: that it is working, its report, or why it failed */
function AgentTodoRunReport({ run }: Readonly<{ run: AgentTodoRun }>): JSX.Element {
    const { translate: _t } = useI18n();
    const errorMessages: Record<AgentTodoRunError, string> = {
        no_workspace: _t("agent_todo|error_no_workspace"),
        not_connected: _t("agent_todo|error_not_connected"),
        rate_limited: _t("agent_todo|error_rate_limited"),
        unknown: _t("agent_todo|error_unknown"),
    };
    let heading: string;
    if (run.state === "running") {
        heading =
            run.mode === "investigate" ? _t("agent_todo|running_investigate") : _t("agent_todo|running_implement");
    } else if (run.state === "failed") {
        heading = errorMessages[run.error ?? "unknown"];
    } else {
        heading = run.mode === "investigate" ? _t("agent_todo|report_investigate") : _t("agent_todo|report_implement");
    }

    return (
        <section
            className={styles.report}
            data-state={run.state}
            aria-busy={run.state === "running"}
            aria-label={_t("agent_todo|report_label")}
        >
            <Flex align="center" gap="var(--cpd-space-2x)">
                <AiIcon className={styles.reportIcon} width="16px" height="16px" aria-hidden />
                <Text size="sm" weight="semibold">
                    {heading}
                </Text>
            </Flex>
            {run.state !== "running" && run.summary && (
                <Text size="sm" className={styles.summary}>
                    {run.summary}
                </Text>
            )}
            {run.changedFiles.length > 0 && (
                <>
                    <Text size="sm" weight="semibold">
                        {_t("agent_todo|changed_files")}
                    </Text>
                    <ul className={styles.files}>
                        {run.changedFiles.map((file) => (
                            <li key={file}>
                                <code>{file}</code>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    );
}
