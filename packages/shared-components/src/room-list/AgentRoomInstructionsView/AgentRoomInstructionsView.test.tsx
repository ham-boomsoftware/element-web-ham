/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { composeStories } from "@storybook/react-vite";
import { describe, it, expect, beforeEach, vi } from "vitest";

import * as stories from "./AgentRoomInstructionsView.stories";

const { Empty, WithInstructions, Saving, SaveFailed } = composeStories(stories);

describe("<AgentRoomInstructionsView />", () => {
    beforeEach(() => {
        vi.mocked(Empty.args.setInstructions!).mockClear();
    });

    it("shows the saved instructions", () => {
        render(<WithInstructions />);
        expect(screen.getByLabelText("Instructions for this chat")).toHaveValue(
            "Answer in English. Don't agree to any dates.",
        );
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("passes on what the user types", async () => {
        const user = userEvent.setup();
        render(<Empty />);

        const field = screen.getByLabelText("Instructions for this chat");
        expect(field).toHaveAttribute("maxlength", "4000");
        await user.type(field, "B");

        expect(Empty.args.setInstructions).toHaveBeenCalledWith("B");
    });

    it("can't be changed while saving", () => {
        render(<Saving />);
        expect(screen.getByLabelText("Instructions for this chat")).toBeDisabled();
    });

    it("says when the instructions could not be saved", () => {
        render(<SaveFailed />);
        expect(screen.getByRole("alert")).toHaveTextContent("The instructions could not be saved. Try again.");
    });
});
