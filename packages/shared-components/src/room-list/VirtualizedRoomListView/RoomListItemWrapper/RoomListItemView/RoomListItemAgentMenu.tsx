/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { MenuItem, Separator, SubMenu } from "@vector-im/compound-web";
import { CheckIcon } from "@vector-im/compound-design-tokens/assets/web/icons";
import AiIcon from "@vector-im/compound-design-tokens/assets/web/icons/ai";
import type { AgentRoomRule } from "shared-types";

import { _t } from "../../../../core/i18n/i18n";
import { useViewModel, type ViewModel } from "../../../../core/viewmodel";
import type { RoomListItemViewSnapshot, RoomListItemViewActions } from "./RoomListItemView";

/**
 * Props for RoomListItemAgentMenu component
 */
export interface RoomListItemAgentMenuProps {
    /** The room item view model */
    vm: ViewModel<RoomListItemViewSnapshot, RoomListItemViewActions>;
}

/**
 * The rule for what the agent does in a room, as a submenu of the more options menu: follow the agent settings,
 * reply by itself (direct messages only), only look for tasks, or ignore the room. It also opens the user's
 * instructions for the agent in the room.
 * It is independent of the notification options, so that the agent can also answer a silent room.
 */
export function RoomListItemAgentMenu({ vm }: RoomListItemAgentMenuProps): JSX.Element {
    const snapshot = useViewModel(vm);
    const options: { rule: AgentRoomRule | undefined; label: string }[] = [
        { rule: undefined, label: _t("room_list|agent_rule_default") },
        ...(snapshot.canAgentReply
            ? [{ rule: "auto_reply" as const, label: _t("room_list|agent_rule_auto_reply") }]
            : []),
        { rule: "tasks_only", label: _t("room_list|agent_rule_tasks_only") },
        { rule: "ignore", label: _t("room_list|agent_rule_ignore") },
    ];

    return (
        <SubMenu trigger={<MenuItem Icon={AiIcon} label={_t("room_list|agent_rule")} onSelect={null} />}>
            {options.map(({ rule, label }) => (
                <MenuItem
                    key={rule ?? "default"}
                    aria-selected={snapshot.agentRule === rule}
                    hideChevron={true}
                    label={label}
                    onSelect={() => vm.onSetAgentRule(rule)}
                    onClick={(evt) => evt.stopPropagation()}
                >
                    {snapshot.agentRule === rule && (
                        <CheckIcon width="24px" height="24px" color="var(--cpd-color-icon-primary)" />
                    )}
                </MenuItem>
            ))}
            <Separator />
            <MenuItem
                hideChevron={true}
                label={_t("room_list|agent_instructions")}
                onSelect={vm.onEditAgentInstructions}
                onClick={(evt) => evt.stopPropagation()}
            />
        </SubMenu>
    );
}
