/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { vi, describe, it, expect, afterEach } from "vitest";

import {
    AgentRoomInstructionsDialogViewModel,
    MAX_ROOM_INSTRUCTIONS_LENGTH,
} from "./AgentRoomInstructionsDialogViewModel";
import type { AgentRoomStore } from "../../agent/AgentRoomStore";

const ROOM_ID = "!a:example.org";

describe("AgentRoomInstructionsDialogViewModel", () => {
    let vm: AgentRoomInstructionsDialogViewModel;

    function create(saved = true): {
        store: { getInstructions: ReturnType<typeof vi.fn>; setInstructions: ReturnType<typeof vi.fn> };
        onFinished: ReturnType<typeof vi.fn>;
    } {
        const store = {
            getInstructions: vi.fn().mockReturnValue("Answer in German"),
            setInstructions: vi.fn().mockResolvedValue(saved),
        };
        const onFinished = vi.fn();
        vm = new AgentRoomInstructionsDialogViewModel({
            roomId: ROOM_ID,
            store: store as unknown as AgentRoomStore,
            onFinished,
        });
        return { store, onFinished };
    }

    afterEach(() => {
        vm?.dispose();
    });

    it("shows the current instructions of the room", () => {
        const { store } = create();

        expect(store.getInstructions).toHaveBeenCalledWith(ROOM_ID);
        expect(vm.getSnapshot()).toEqual({
            instructions: "Answer in German",
            maxLength: MAX_ROOM_INSTRUCTIONS_LENGTH,
            isSaving: false,
            hasError: false,
        });
    });

    it("saves the edited instructions and closes", async () => {
        const { store, onFinished } = create();

        vm.setInstructions("Be brief");
        vm.save();
        expect(vm.getSnapshot().isSaving).toBe(true);

        await vi.waitFor(() => expect(onFinished).toHaveBeenCalled());
        expect(store.setInstructions).toHaveBeenCalledWith(ROOM_ID, "Be brief");
    });

    it("stays open and shows an error when the instructions can't be saved", async () => {
        const { onFinished } = create(false);

        vm.save();

        await vi.waitFor(() => expect(vm.getSnapshot().hasError).toBe(true));
        expect(vm.getSnapshot().isSaving).toBe(false);
        expect(onFinished).not.toHaveBeenCalled();

        vm.setInstructions("Be brief");
        expect(vm.getSnapshot().hasError).toBe(false);
    });

    it("closes without saving when cancelled", () => {
        const { store, onFinished } = create();

        vm.cancel();

        expect(onFinished).toHaveBeenCalled();
        expect(store.setInstructions).not.toHaveBeenCalled();
    });
});
