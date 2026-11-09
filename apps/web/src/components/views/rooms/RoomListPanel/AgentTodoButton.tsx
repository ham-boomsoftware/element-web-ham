/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX } from "react";
import { Button } from "@vector-im/compound-web";
import CheckCircleIcon from "@vector-im/compound-design-tokens/assets/web/icons/check-circle";

import { _t } from "../../../../languageHandler";
import Modal from "../../../../Modal";
import PlatformPeg from "../../../../PlatformPeg";
import { AgentTaskStore, AgentTaskStoreEvent } from "../../../../agent/AgentTaskStore";
import { useEventEmitterState } from "../../../../hooks/useEventEmitter";
import { AgentTodoDialog } from "../../dialogs/AgentTodoDialog";

/**
 * Opens the user's to-do list, and shows how many tasks are still open. Shows nothing on a platform without an
 * agent.
 */
export function AgentTodoButton(): JSX.Element | null {
    const store = AgentTaskStore.instance;
    const isAvailable = useEventEmitterState(store, AgentTaskStoreEvent.Update, () => store.isAvailable);
    const openCount = useEventEmitterState(store, AgentTaskStoreEvent.Update, () => store.openCount);
    const agent = PlatformPeg.get()?.agent;
    if (!isAvailable || !agent) return null;

    return (
        <Button
            className="mx_AgentTodoButton"
            kind="tertiary"
            size="md"
            Icon={CheckCircleIcon}
            onClick={() => Modal.createDialog(AgentTodoDialog, { agent })}
        >
            {_t("agent_todo_list|button", { number: openCount })}
        </Button>
    );
}
