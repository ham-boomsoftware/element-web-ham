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
    /** Whether the agent can work on tasks: a provider is connected and a project folder is set */
    canRun: boolean;
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
 * themselves. The agent can look into a task, or do it, in the user's project folder.
 *
 * @example
 * ```tsx
 * <AgentTodoView vm={agentTodoViewModel} />
 * ```
 */
export function AgentTodoView({ vm }: Readonly<AgentTodoViewProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { filter, items, openCount, doneCount, canRun } = useViewModel(vm);
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
                <Text size="md" className={styles.hint}>
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
                        <AgentTodoEntry key={item.id} item={item} canRun={canRun} vm={vm} />
                    ))}
                </ul>
            )}
        </Flex>
    );
}

interface AgentTodoEntryProps {
    item: AgentTodoItem;
    canRun: boolean;
    vm: AgentTodoViewModel;
}

/** One task of the list, with its actions and the latest report of the agent */
function AgentTodoEntry({ item, canRun, vm }: Readonly<AgentTodoEntryProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { id, title, details, done, sender, chatName, date, canOpenChat, run } = item;
    const isRunning = run?.state === "running";
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
                    <Text size="md" className={styles.meta}>
                        {origin}
                    </Text>
                    {details && (
                        <Text size="md" className={styles.details}>
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
                                    disabled={!canRun || isRunning}
                                    onClick={() => vm.runTask(id, "investigate")}
                                >
                                    {_t("agent_todo|investigate")}
                                </Button>
                                <Button
                                    kind="secondary"
                                    size="md"
                                    disabled={!canRun || isRunning}
                                    onClick={() => vm.runTask(id, "implement")}
                                >
                                    {_t("agent_todo|implement")}
                                </Button>
                            </>
                        )}
                        <Button kind="tertiary" size="md" destructive onClick={() => vm.deleteTask(id)}>
                            {_t("action|delete")}
                        </Button>
                    </Flex>

                    {run && <AgentTodoRunReport run={run} />}
                </Flex>
            </Flex>
        </li>
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
                <Text size="md" weight="semibold">
                    {heading}
                </Text>
            </Flex>
            {run.state !== "running" && run.summary && (
                <Text size="md" className={styles.summary}>
                    {run.summary}
                </Text>
            )}
            {run.changedFiles.length > 0 && (
                <>
                    <Text size="md" weight="semibold">
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
