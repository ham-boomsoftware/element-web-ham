/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { render, screen } from "@test-utils";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { RoomListItemAgentMenu } from "./RoomListItemAgentMenu";
import { MoreOptionContent } from "./RoomListItemMoreOptionsMenu";
import { useMockedViewModel } from "../../../../core/viewmodel";
import type { RoomListItemViewSnapshot } from "./RoomListItemView";
import { defaultSnapshot } from "./default-snapshot";
import { mockedActions as mockCallbacks } from "./mocked-actions";

describe("<RoomListItemAgentMenu />", () => {
    // Rendered on its own, outside of the more options menu, the submenu shows its entries directly
    const renderMenu = (overrides: Partial<RoomListItemViewSnapshot> = {}): ReturnType<typeof render> => {
        const TestComponent = (): JSX.Element => {
            const vm = useMockedViewModel({ ...defaultSnapshot, canUseAgent: true, ...overrides }, mockCallbacks);
            return <RoomListItemAgentMenu vm={vm} />;
        };
        return render(<TestComponent />);
    };

    /** The labels of the rules, in the order they are shown */
    const getOptionLabels = (): (string | null)[] =>
        screen
            .getAllByRole("menuitem")
            .filter((item) => item.hasAttribute("aria-selected"))
            .map((item) => item.textContent);

    beforeEach(() => {
        vi.mocked(mockCallbacks.onSetAgentRule).mockClear();
    });

    it("should offer replying automatically in a direct message only", () => {
        const { unmount } = renderMenu({ canAgentReply: true });
        expect(getOptionLabels()).toEqual(["Standard", "Reply automatically", "Tasks only", "Ignore"]);
        unmount();

        renderMenu({ canAgentReply: false });
        expect(getOptionLabels()).toEqual(["Standard", "Tasks only", "Ignore"]);
    });

    it.each([
        [undefined, "Standard"],
        ["auto_reply", "Reply automatically"],
        ["tasks_only", "Tasks only"],
        ["ignore", "Ignore"],
    ] as const)("should mark the rule %s", (agentRule, label) => {
        renderMenu({ canAgentReply: true, agentRule });

        const selected = screen
            .getAllByRole("menuitem")
            .filter((item) => item.getAttribute("aria-selected") === "true");
        expect(selected.map((item) => item.textContent)).toEqual([label]);
    });

    it.each([
        ["Standard", undefined],
        ["Reply automatically", "auto_reply"],
        ["Tasks only", "tasks_only"],
        ["Ignore", "ignore"],
    ] as const)("should set the rule when %s is selected", async (label, rule) => {
        const user = userEvent.setup();
        renderMenu({ canAgentReply: true, agentRule: "ignore" });

        await user.click(screen.getByRole("menuitem", { name: label }));

        expect(mockCallbacks.onSetAgentRule).toHaveBeenCalledWith(rule);
    });

    it("should only be in the more options menu where the agent can be used", () => {
        const renderOptions = (canUseAgent: boolean): ReturnType<typeof render> => {
            const TestComponent = (): JSX.Element => {
                const vm = useMockedViewModel({ ...defaultSnapshot, canUseAgent }, mockCallbacks);
                return <MoreOptionContent vm={vm} />;
            };
            return render(<TestComponent />);
        };

        const { unmount } = renderOptions(false);
        expect(screen.queryByRole("menuitem", { name: "Agent" })).not.toBeInTheDocument();
        unmount();

        renderOptions(true);
        expect(screen.getByRole("menuitem", { name: "Agent" })).toBeInTheDocument();
    });
});
