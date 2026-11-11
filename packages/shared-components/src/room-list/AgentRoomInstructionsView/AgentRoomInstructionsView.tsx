/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { Text } from "@vector-im/compound-web";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import styles from "./AgentRoomInstructionsView.module.css";

export interface AgentRoomInstructionsViewSnapshot {
    /** The instructions as the user is typing them */
    instructions: string;
    /** The longest instructions the agent accepts */
    maxLength: number;
    /** Whether the instructions are being saved, during which they can't be changed */
    isSaving: boolean;
    /** Whether saving the instructions failed */
    hasError: boolean;
}

export interface AgentRoomInstructionsViewActions {
    /** Change the instructions as the user types */
    setInstructions: (instructions: string) => void;
}

/**
 * The view model of {@link AgentRoomInstructionsView}.
 */
export type AgentRoomInstructionsViewModel = ViewModel<
    AgentRoomInstructionsViewSnapshot,
    AgentRoomInstructionsViewActions
>;

export interface AgentRoomInstructionsViewProps {
    /** The view model of the instructions */
    vm: AgentRoomInstructionsViewModel;
}

/**
 * The field for the user's instructions for the agent in a single room. The agent follows them there on top of the
 * general instructions from the agent settings. Saving and cancelling are left to the dialog around it.
 */
export function AgentRoomInstructionsView({ vm }: Readonly<AgentRoomInstructionsViewProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const { instructions, maxLength, isSaving, hasError } = useViewModel(vm);

    return (
        <Flex direction="column" gap="var(--cpd-space-2x)">
            <label className={styles.label} htmlFor="mx_AgentRoomInstructions_field">
                {_t("room_list|agent_instructions_label")}
            </label>
            <textarea
                id="mx_AgentRoomInstructions_field"
                className={styles.field}
                rows={6}
                value={instructions}
                maxLength={maxLength}
                disabled={isSaving}
                placeholder={_t("room_list|agent_instructions_placeholder")}
                onChange={(ev) => vm.setInstructions(ev.currentTarget.value)}
            />
            <Text size="sm" className={styles.description}>
                {_t("room_list|agent_instructions_description")}
            </Text>
            {hasError && (
                <Text size="sm" className={styles.error} role="alert">
                    {_t("room_list|agent_instructions_error")}
                </Text>
            )}
        </Flex>
    );
}
