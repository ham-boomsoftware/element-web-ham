/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import { AgentTodoView, useCreateAutoDisposedViewModel } from "@element-hq/web-shared-components";

import { _t } from "../../../languageHandler";
import BaseDialog from "./BaseDialog";
import { AgentTodoViewModel } from "../../../viewmodels/agent/AgentTodoViewModel";
import { AgentTaskStore } from "../../../agent/AgentTaskStore";
import type { AgentApi } from "../../../agent/AgentApi";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { type ViewRoomPayload } from "../../../dispatcher/payloads/ViewRoomPayload";

interface Props {
    /** The agent of the platform */
    agent: AgentApi;
    onFinished(): void;
}

/**
 * The user's to-do list, collected by the agent from what others asked them in chats.
 */
export function AgentTodoDialog({ agent, onFinished }: Readonly<Props>): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(
        () =>
            new AgentTodoViewModel({
                store: AgentTaskStore.instance,
                agent,
                onOpenChat: (roomId, eventId) => {
                    defaultDispatcher.dispatch<ViewRoomPayload>({
                        action: Action.ViewRoom,
                        room_id: roomId,
                        event_id: eventId,
                        highlighted: Boolean(eventId),
                        scroll_into_view: Boolean(eventId),
                        metricsTrigger: undefined,
                    });
                    onFinished();
                },
            }),
    );

    return (
        <BaseDialog
            className="mx_AgentTodoDialog"
            title={_t("agent_todo_list|title")}
            onFinished={onFinished}
            hasCancel
        >
            <AgentTodoView vm={vm} />
        </BaseDialog>
    );
}
