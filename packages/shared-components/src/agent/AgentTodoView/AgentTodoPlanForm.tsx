/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useState } from "react";
import { Button, Text } from "@vector-im/compound-web";
import AiIcon from "@vector-im/compound-design-tokens/assets/web/icons/ai";
import CalendarIcon from "@vector-im/compound-design-tokens/assets/web/icons/calendar";

import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import type { AgentTodoPlanning, AgentTodoViewModel } from "./AgentTodoView";
import styles from "./AgentTodoView.module.css";

/** The durations to choose from, in minutes */
const DURATIONS = [15, 30, 60, 90, 120, 180, 240];

/**
 * The end of a time block, as `HH:MM`.
 * @param start - The start, `YYYY-MM-DDTHH:MM`
 * @returns the end, or undefined if the start is not a valid time
 */
function endOfBlock(start: string, durationMinutes: number): string | undefined {
    const match = /T(\d{2}):(\d{2})$/.exec(start);
    if (!match) return undefined;
    const minutes = (Number(match[1]) * 60 + Number(match[2]) + durationMinutes) % (24 * 60);
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

interface AgentTodoPlanFormProps {
    planning: AgentTodoPlanning;
    vm: AgentTodoViewModel;
}

/**
 * Plan a time to work on a task: the agent suggests a time and a duration, which the user can change before the
 * calendar entry is made.
 */
export function AgentTodoPlanForm({ planning, vm }: Readonly<AgentTodoPlanFormProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { id, state, reason } = planning;
    const [start, setStart] = useState(planning.start);
    const [durationMinutes, setDuration] = useState(planning.durationMinutes);
    const startId = `mx_AgentTodo_plan_start_${id}`;
    const isSuggesting = state === "suggesting";
    const end = endOfBlock(start, durationMinutes);
    const durations = DURATIONS.includes(durationMinutes)
        ? DURATIONS
        : [...DURATIONS, durationMinutes].sort((a, b) => a - b);

    return (
        <form
            className={styles.plan}
            data-state={state}
            aria-label={_t("agent_todo|plan_label")}
            aria-busy={isSuggesting}
            onSubmit={(ev) => {
                ev.preventDefault();
                if (start && !isSuggesting) vm.scheduleTask(id, start, durationMinutes);
            }}
        >
            <Flex align="center" gap="var(--cpd-space-2x)">
                <CalendarIcon className={styles.planIcon} width="20px" height="20px" aria-hidden />
                <Text size="sm" weight="semibold">
                    {_t("agent_todo|plan_heading")}
                </Text>
            </Flex>

            {isSuggesting ? (
                <Flex align="center" gap="var(--cpd-space-2x)" role="status" className={styles.planSuggesting}>
                    <AiIcon className={styles.reportIcon} width="16px" height="16px" aria-hidden />
                    <Text size="sm">{_t("agent_todo|plan_suggesting")}</Text>
                </Flex>
            ) : (
                reason && (
                    <Flex align="start" gap="var(--cpd-space-2x)" className={styles.planReason}>
                        <AiIcon className={styles.reportIcon} width="16px" height="16px" aria-hidden />
                        <Text size="sm">{reason}</Text>
                    </Flex>
                )
            )}

            <label className={styles.launchLabel} htmlFor={startId}>
                {_t("agent_todo|plan_start")}
            </label>
            <input
                id={startId}
                type="datetime-local"
                className={styles.control}
                value={start}
                step={900}
                required
                disabled={isSuggesting}
                onChange={(ev) => setStart(ev.currentTarget.value)}
            />

            <Text as="span" size="sm" weight="medium" className={styles.launchLabel}>
                {_t("agent_todo|plan_duration")}
            </Text>
            <Flex role="group" aria-label={_t("agent_todo|plan_duration")} gap="var(--cpd-space-2x)" wrap="wrap">
                {durations.map((minutes) => (
                    <button
                        key={minutes}
                        type="button"
                        className={styles.filter}
                        aria-pressed={durationMinutes === minutes}
                        disabled={isSuggesting}
                        onClick={() => setDuration(minutes)}
                    >
                        {minutes < 60 || minutes % 30 !== 0
                            ? _t("agent_todo|duration_minutes", { count: minutes })
                            : _t("agent_todo|duration_hours", { count: minutes / 60 })}
                    </button>
                ))}
            </Flex>

            <Flex align="center" justify="space-between" gap="var(--cpd-space-2x)" wrap="wrap">
                <Text size="sm" className={styles.hint}>
                    {end && !isSuggesting ? _t("agent_todo|plan_until", { time: end }) : ""}
                </Text>
                <Flex gap="var(--cpd-space-2x)">
                    <Button type="button" kind="tertiary" size="md" onClick={vm.cancelPlanning}>
                        {_t("action|cancel")}
                    </Button>
                    <Button
                        type="submit"
                        kind="primary"
                        size="md"
                        Icon={CalendarIcon}
                        disabled={!start || isSuggesting || state === "saving"}
                    >
                        {_t("agent_todo|plan_confirm")}
                    </Button>
                </Flex>
            </Flex>

            {state === "failed" && (
                <Text size="sm" role="alert" className={styles.launchError}>
                    {_t("agent_todo|plan_failed")}
                </Text>
            )}
        </form>
    );
}
