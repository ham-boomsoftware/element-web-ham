/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { fn } from "storybook/test";

import type { Meta, StoryObj } from "@storybook/react-vite";
import {
    AgentRoomInstructionsView,
    type AgentRoomInstructionsViewActions,
    type AgentRoomInstructionsViewSnapshot,
} from "./AgentRoomInstructionsView";
import { useMockedViewModel } from "../../core/viewmodel";
import { withViewDocs } from "../../../.storybook/withViewDocs";

type AgentRoomInstructionsProps = AgentRoomInstructionsViewSnapshot & AgentRoomInstructionsViewActions;

const AgentRoomInstructionsViewWrapperImpl = ({
    setInstructions,
    ...rest
}: AgentRoomInstructionsProps): JSX.Element => {
    const vm = useMockedViewModel(rest, { setInstructions });
    return <AgentRoomInstructionsView vm={vm} />;
};
const AgentRoomInstructionsViewWrapper = withViewDocs(AgentRoomInstructionsViewWrapperImpl, AgentRoomInstructionsView);

const meta = {
    title: "Room List/AgentRoomInstructionsView",
    component: AgentRoomInstructionsViewWrapper,
    tags: ["autodocs"],
    args: {
        instructions: "",
        maxLength: 4000,
        isSaving: false,
        hasError: false,
        setInstructions: fn(),
    },
} satisfies Meta<typeof AgentRoomInstructionsViewWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No instructions yet: the field shows an example */
export const Empty: Story = {};

/** Instructions the user wrote earlier */
export const WithInstructions: Story = {
    args: {
        instructions: "Answer in English. Don't agree to any dates.",
    },
};

/** The instructions are being saved */
export const Saving: Story = {
    args: {
        instructions: "Answer in English.",
        isSaving: true,
    },
};

/** Saving the instructions failed */
export const SaveFailed: Story = {
    args: {
        instructions: "Answer in English.",
        hasError: true,
    },
};
