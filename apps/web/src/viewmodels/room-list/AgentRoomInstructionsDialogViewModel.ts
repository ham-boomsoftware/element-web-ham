/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    BaseViewModel,
    type AgentRoomInstructionsViewModel as AgentRoomInstructionsViewModelInterface,
    type AgentRoomInstructionsViewSnapshot,
} from "@element-hq/web-shared-components";

import type { AgentRoomStore } from "../../agent/AgentRoomStore";

/** The longest instructions for a room; the desktop agent refuses longer ones */
export const MAX_ROOM_INSTRUCTIONS_LENGTH = 4000;

export interface Props {
    /** The room the instructions are for */
    roomId: string;
    /** The store that holds and saves the instructions */
    store: AgentRoomStore;
    /** Called when the dialog should close, after saving or cancelling */
    onFinished: () => void;
}

/**
 * View model of the dialog for the user's instructions for the agent in a room.
 */
export class AgentRoomInstructionsDialogViewModel
    extends BaseViewModel<AgentRoomInstructionsViewSnapshot, Props>
    implements AgentRoomInstructionsViewModelInterface
{
    public constructor(props: Props) {
        super(props, {
            instructions: props.store.getInstructions(props.roomId) ?? "",
            maxLength: MAX_ROOM_INSTRUCTIONS_LENGTH,
            isSaving: false,
            hasError: false,
        });
    }

    public setInstructions = (instructions: string): void => {
        this.snapshot.merge({ instructions, hasError: false });
    };

    /** Save the instructions, or remove them if they are blank, and close the dialog once they are saved */
    public save = (): void => {
        if (this.snapshot.current.isSaving) return;
        const { roomId, store, onFinished } = this.props;
        this.snapshot.merge({ isSaving: true, hasError: false });
        void (async () => {
            const saved = await store.setInstructions(roomId, this.snapshot.current.instructions);
            if (this.isDisposed) return;
            if (saved) {
                onFinished();
            } else {
                this.snapshot.merge({ isSaving: false, hasError: true });
            }
        })();
    };

    public cancel = (): void => {
        this.props.onFinished();
    };
}
