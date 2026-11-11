/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type ComponentType, type JSX, type SVGAttributes, useState } from "react";
import { Button, Text } from "@vector-im/compound-web";
import ListBulletedIcon from "@vector-im/compound-design-tokens/assets/web/icons/list-bulleted";
import DocumentIcon from "@vector-im/compound-design-tokens/assets/web/icons/document";
import SearchIcon from "@vector-im/compound-design-tokens/assets/web/icons/search";
import ComposeIcon from "@vector-im/compound-design-tokens/assets/web/icons/compose";
import EditIcon from "@vector-im/compound-design-tokens/assets/web/icons/edit";
import CodeIcon from "@vector-im/compound-design-tokens/assets/web/icons/code";
import TreeIcon from "@vector-im/compound-design-tokens/assets/web/icons/tree";
import ErrorIcon from "@vector-im/compound-design-tokens/assets/web/icons/error-solid";
import CheckIcon from "@vector-im/compound-design-tokens/assets/web/icons/check-circle-solid";
import WarningIcon from "@vector-im/compound-design-tokens/assets/web/icons/warning";
import ArrowUpRightIcon from "@vector-im/compound-design-tokens/assets/web/icons/arrow-up-right";
import FolderIcon from "@vector-im/compound-design-tokens/assets/web/icons/folder";
import ChatIcon from "@vector-im/compound-design-tokens/assets/web/icons/chat";

import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import type {
    AgentTodoBranch,
    AgentTodoChatReport,
    AgentTodoDiff,
    AgentTodoDiffFile,
    AgentTodoStep,
    AgentTodoViewModel,
} from "./AgentTodoView";
import styles from "./AgentTodoAutopilot.module.css";

const STEP_ICONS: Record<AgentTodoStep["kind"], ComponentType<SVGAttributes<SVGElement>>> = {
    list: ListBulletedIcon,
    read: DocumentIcon,
    search: SearchIcon,
    write: ComposeIcon,
    edit: EditIcon,
    command: CodeIcon,
    git: TreeIcon,
};

/** How many of the latest steps are shown until the user asks for all of them */
const VISIBLE_STEPS = 6;

interface AgentTodoTimelineProps {
    steps: AgentTodoStep[];
    /** Whether the agent is still working, so the latest step is the current one */
    isRunning: boolean;
}

/** The steps of the agent's work as a timeline, the current one pulsing while it works */
export function AgentTodoTimeline({ steps, isRunning }: Readonly<AgentTodoTimelineProps>): JSX.Element | null {
    const { translate: _t } = useI18n();
    const [showAll, setShowAll] = useState(false);
    if (steps.length === 0 && !isRunning) return null;

    const hidden = showAll ? 0 : Math.max(0, steps.length - VISIBLE_STEPS);
    const shown = steps.slice(hidden);
    const stepLabels: Record<AgentTodoStep["kind"], string> = {
        list: _t("agent_todo|step_list"),
        read: _t("agent_todo|step_read"),
        search: _t("agent_todo|step_search"),
        write: _t("agent_todo|step_write"),
        edit: _t("agent_todo|step_edit"),
        command: _t("agent_todo|step_command"),
        git: _t("agent_todo|step_git"),
    };

    return (
        <div className={styles.timeline}>
            {hidden > 0 && (
                <button type="button" className={styles.moreSteps} onClick={() => setShowAll(true)}>
                    {_t("agent_todo|steps_show_all", { count: steps.length })}
                </button>
            )}
            <ol className={styles.steps} aria-label={_t("agent_todo|steps_label")} aria-live="polite">
                {shown.map((step, index) => {
                    const isCurrent = isRunning && index === shown.length - 1;
                    const Icon = step.failed ? ErrorIcon : STEP_ICONS[step.kind];
                    return (
                        <li
                            // Steps are only ever added at the end, so their position is a stable key
                            // oxlint-disable-next-line react/no-array-index-key
                            key={hidden + index}
                            className={styles.step}
                            data-kind={step.kind}
                            data-failed={step.failed}
                            aria-current={isCurrent ? "step" : undefined}
                        >
                            <span className={styles.stepDot}>
                                <Icon width="14px" height="14px" aria-hidden />
                            </span>
                            <span className={styles.stepLabel}>{stepLabels[step.kind]}</span>
                            <code className={styles.stepText} title={step.text}>
                                {step.text}
                            </code>
                            <time className={styles.stepTime}>{step.time}</time>
                        </li>
                    );
                })}
                {isRunning && shown.length === 0 && (
                    <li className={styles.step} aria-current="step">
                        <span className={styles.stepDot} />
                        <span className={styles.stepLabel}>{_t("agent_todo|step_starting")}</span>
                    </li>
                )}
            </ol>
        </div>
    );
}

interface AgentTodoBranchCardProps {
    /** The task */
    id: string;
    branch: AgentTodoBranch;
    isRunning: boolean;
    /** The changes of a task that are shown */
    diff?: AgentTodoDiff;
    vm: AgentTodoViewModel;
}

/** The branch of the autopilot: whether it is committed and pushed, a pull request link and its changes */
export function AgentTodoBranchCard({
    id,
    branch,
    isRunning,
    diff,
    vm,
}: Readonly<AgentTodoBranchCardProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const ownDiff = diff?.id === id ? diff : undefined;
    const canShowChanges = branch.hasWorktree || !!branch.commit;

    return (
        <div className={styles.branch} aria-label={_t("agent_todo|branch_label")} role="group">
            <Flex gap="var(--cpd-space-2x)" wrap="wrap" align="center">
                <span className={styles.chip} data-kind="branch">
                    <TreeIcon width="14px" height="14px" aria-hidden />
                    <code>{branch.name}</code>
                </span>
                <span className={styles.chipMuted}>{_t("agent_todo|branch_from", { base: branch.base })}</span>
                {branch.commit && (
                    <span className={styles.chip} data-kind="commit">
                        <code>{branch.commit}</code>
                    </span>
                )}
                {!isRunning && !branch.commit && <span className={styles.chipMuted}>{_t("agent_todo|no_commit")}</span>}
                {branch.pushed && (
                    <span className={styles.chip} data-kind="pushed">
                        <CheckIcon width="14px" height="14px" aria-hidden />
                        {_t("agent_todo|pushed")}
                    </span>
                )}
                {branch.pushError && (
                    <span className={styles.chip} data-kind="failed" title={branch.pushError}>
                        <WarningIcon width="14px" height="14px" aria-hidden />
                        {_t("agent_todo|push_failed")}
                    </span>
                )}
            </Flex>
            {branch.pushError && (
                <Text size="sm" className={styles.pushError}>
                    {branch.pushError}
                </Text>
            )}

            {!isRunning && (
                <Flex gap="var(--cpd-space-2x)" wrap="wrap">
                    {branch.pullRequestUrl && (
                        <Button
                            as="a"
                            kind="primary"
                            size="sm"
                            Icon={ArrowUpRightIcon}
                            href={branch.pullRequestUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                        >
                            {_t("agent_todo|open_pull_request")}
                        </Button>
                    )}
                    {canShowChanges && (
                        <Button kind="secondary" size="sm" aria-expanded={!!ownDiff} onClick={() => vm.toggleDiff(id)}>
                            {ownDiff ? _t("agent_todo|hide_changes") : _t("agent_todo|show_changes")}
                        </Button>
                    )}
                    {branch.hasWorktree && (
                        <>
                            <Button kind="tertiary" size="sm" Icon={FolderIcon} onClick={() => vm.openWorktree(id)}>
                                {_t("agent_todo|open_worktree")}
                            </Button>
                            <Button kind="tertiary" size="sm" Icon={CodeIcon} onClick={() => vm.continueInCli(id)}>
                                {_t("agent_todo|continue_in_cli")}
                            </Button>
                            <Button kind="tertiary" size="sm" destructive onClick={() => vm.removeWorktree(id)}>
                                {_t("agent_todo|remove_worktree")}
                            </Button>
                        </>
                    )}
                </Flex>
            )}

            {ownDiff && <AgentTodoDiffViewer diff={ownDiff} />}
        </div>
    );
}

/** The changes of the autopilot, one collapsible block per file */
export function AgentTodoDiffViewer({ diff }: Readonly<{ diff: AgentTodoDiff }>): JSX.Element {
    const { translate: _t } = useI18n();
    if (diff.state === "loading") {
        return (
            <Text size="sm" role="status" className={styles.diffStatus}>
                {_t("agent_todo|changes_loading")}
            </Text>
        );
    }
    if (diff.state === "failed") {
        return (
            <Text size="sm" role="alert" className={styles.diffError}>
                {_t("agent_todo|changes_failed")}
            </Text>
        );
    }
    if (diff.files.length === 0) {
        return (
            <Text size="sm" role="status" className={styles.diffStatus}>
                {_t("agent_todo|changes_none")}
            </Text>
        );
    }

    const additions = diff.files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = diff.files.reduce((sum, file) => sum + file.deletions, 0);
    return (
        <section className={styles.diff} aria-label={_t("agent_todo|changes_label")}>
            <Text size="sm" weight="semibold" className={styles.diffTotal}>
                {_t("agent_todo|changes_total", { count: diff.files.length })}
                <span className={styles.additions}>+{additions}</span>
                <span className={styles.deletions}>−{deletions}</span>
            </Text>
            {diff.files.map((file) => (
                <AgentTodoDiffFileView key={file.path} file={file} />
            ))}
        </section>
    );
}

/** How many squares the bar of a file has, like GitHub's */
const BAR_SIZE = 5;

/** The changes of one file */
function AgentTodoDiffFileView({ file }: Readonly<{ file: AgentTodoDiffFile }>): JSX.Element {
    const { translate: _t } = useI18n();
    const total = file.additions + file.deletions;
    const added = total === 0 ? 0 : Math.round((file.additions / total) * BAR_SIZE);
    const removed = total === 0 ? 0 : Math.min(BAR_SIZE - added, Math.round((file.deletions / total) * BAR_SIZE));
    const statusLabels: Record<AgentTodoDiffFile["status"], string> = {
        added: _t("agent_todo|file_added"),
        modified: _t("agent_todo|file_modified"),
        deleted: _t("agent_todo|file_deleted"),
        renamed: _t("agent_todo|file_renamed"),
    };

    return (
        <details className={styles.diffFile} open={file.lines.length > 0 && file.lines.length <= 80}>
            <summary className={styles.diffHeader}>
                <span className={styles.fileStatus} data-status={file.status} title={statusLabels[file.status]}>
                    {statusLabels[file.status].charAt(0)}
                </span>
                <code className={styles.filePath}>{file.path}</code>
                <span className={styles.additions}>+{file.additions}</span>
                <span className={styles.deletions}>−{file.deletions}</span>
                <span className={styles.bar} aria-hidden>
                    {Array.from({ length: BAR_SIZE }, (_, index) => (
                        <span
                            key={index}
                            data-type={index < added ? "add" : index < added + removed ? "remove" : "none"}
                        />
                    ))}
                </span>
            </summary>
            {file.lines.length > 0 && (
                <pre className={styles.diffLines}>
                    {file.lines.map((line, index) => (
                        // The lines of a diff never change, and the same text can appear on many of them
                        // oxlint-disable-next-line react/no-array-index-key
                        <span key={index} className={styles.diffLine} data-type={line.type}>
                            {line.text}
                            {"\n"}
                        </span>
                    ))}
                </pre>
            )}
            {file.truncated && (
                <Text size="sm" className={styles.diffStatus}>
                    {_t("agent_todo|changes_truncated")}
                </Text>
            )}
        </details>
    );
}

interface AgentTodoChatReportFormProps {
    /** The task */
    id: string;
    /** The suggested text */
    text: string;
    /** The latest report to a chat */
    report?: AgentTodoChatReport;
    vm: AgentTodoViewModel;
}

/** Tell the chat a task came from what the agent did, with a text the user can change first */
export function AgentTodoChatReportForm({ id, text, report, vm }: Readonly<AgentTodoChatReportFormProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const [isOpen, setOpen] = useState(false);
    const [draft, setDraft] = useState(text);
    const ownReport = report?.id === id ? report : undefined;
    const textId = `mx_AgentTodo_chatReport_${id}`;

    if (ownReport?.state === "sent") {
        return (
            <Text size="sm" role="status" className={styles.reportSent}>
                <CheckIcon width="16px" height="16px" aria-hidden />
                {_t("agent_todo|chat_report_sent")}
            </Text>
        );
    }
    if (!isOpen) {
        return (
            <Flex>
                <Button kind="secondary" size="sm" Icon={ChatIcon} onClick={() => setOpen(true)}>
                    {_t("agent_todo|chat_report")}
                </Button>
            </Flex>
        );
    }

    return (
        <form
            className={styles.chatReport}
            aria-label={_t("agent_todo|chat_report")}
            onSubmit={(ev) => {
                ev.preventDefault();
                if (draft.trim()) vm.reportToChat(id, draft.trim());
            }}
        >
            <label className={styles.chatReportLabel} htmlFor={textId}>
                {_t("agent_todo|chat_report_label")}
            </label>
            <textarea
                id={textId}
                className={styles.chatReportText}
                rows={Math.min(8, Math.max(3, draft.split("\n").length))}
                value={draft}
                onChange={(ev) => setDraft(ev.currentTarget.value)}
            />
            <Flex gap="var(--cpd-space-2x)" justify="end">
                <Button type="button" kind="tertiary" size="sm" onClick={() => setOpen(false)}>
                    {_t("action|cancel")}
                </Button>
                <Button
                    type="submit"
                    kind="primary"
                    size="sm"
                    disabled={!draft.trim() || ownReport?.state === "sending"}
                >
                    {_t("agent_todo|chat_report_send")}
                </Button>
            </Flex>
            {ownReport?.state === "failed" && (
                <Text size="sm" role="alert" className={styles.diffError}>
                    {_t("agent_todo|chat_report_failed")}
                </Text>
            )}
        </form>
    );
}
