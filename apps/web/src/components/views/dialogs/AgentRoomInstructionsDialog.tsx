/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import {
    AgentRoomInstructionsView,
    useCreateAutoDisposedViewModel,
    useViewModel,
} from "@element-hq/web-shared-components";

import BaseDialog from "./BaseDialog";
import DialogButtons from "../elements/DialogButtons";
import { _t } from "../../../languageHandler";
import { AgentRoomStore } from "../../../agent/AgentRoomStore";
import { AgentRoomInstructionsDialogViewModel } from "../../../viewmodels/room-list/AgentRoomInstructionsDialogViewModel";

interface AgentRoomInstructionsDialogProps {
    /** The room the instructions are for */
    roomId: string;
    /** The name of the room, for the title */
    roomName: string;
    /** Called when the dialog closes */
    onFinished: () => void;
}

/**
 * Dialog for the user's instructions for the agent in a room.
 */
export function AgentRoomInstructionsDialog({
    roomId,
    roomName,
    onFinished,
}: AgentRoomInstructionsDialogProps): JSX.Element {
    const vm = useCreateAutoDisposedViewModel(
        () => new AgentRoomInstructionsDialogViewModel({ roomId, store: AgentRoomStore.instance, onFinished }),
    );
    const { isSaving } = useViewModel(vm);

    return (
        <BaseDialog
            onFinished={vm.cancel}
            title={_t("agent_room_instructions_dialog|title", { roomName })}
            hasCancel={true}
        >
            <AgentRoomInstructionsView vm={vm} />
            <DialogButtons
                primaryButton={_t("common|save")}
                primaryDisabled={isSaving}
                hasCancel={true}
                cancelButton={_t("common|cancel")}
                onCancel={vm.cancel}
                onPrimaryButtonClick={vm.save}
            />
        </BaseDialog>
    );
}
