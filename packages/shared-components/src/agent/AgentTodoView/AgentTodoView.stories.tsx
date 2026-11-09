/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX } from "react";
import { fn } from "storybook/test";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentTodoView, type AgentTodoViewActions, type AgentTodoViewSnapshot } from "./AgentTodoView";
import { useMockedViewModel } from "../../core/viewmodel";
import { withViewDocs } from "../../../.storybook/withViewDocs";

type AgentTodoProps = AgentTodoViewSnapshot & AgentTodoViewActions;

const AgentTodoViewWrapperImpl = ({
    setFilter,
    addTask,
    setDone,
    deleteTask,
    openChat,
    runTask,
    ...rest
}: AgentTodoProps): JSX.Element => {
    const vm = useMockedViewModel(rest, { setFilter, addTask, setDone, deleteTask, openChat, runTask });
    return <AgentTodoView vm={vm} />;
};
const AgentTodoViewWrapper = withViewDocs(AgentTodoViewWrapperImpl, AgentTodoView);

const meta = {
    title: "Agent/AgentTodoView",
    component: AgentTodoViewWrapper,
    tags: ["autodocs"],
    args: {
        filter: "open",
        openCount: 3,
        doneCount: 1,
        canRun: true,
        items: [
            {
                id: "1",
                title: "Create a ticket for the login bug",
                details: "Bob asked for a ticket: logging in with SSO fails since yesterday's release.",
                done: false,
                sender: "Bob",
                chatName: "Team",
                date: "Mon, 9 Nov, 12:40",
                canOpenChat: true,
            },
            {
                id: "2",
                title: "Look at the failing build",
                details: "Carol: the nightly build fails in the settings tests.",
                done: false,
                sender: "Carol",
                chatName: "Carol",
                date: "Mon, 9 Nov, 11:02",
                canOpenChat: true,
                run: {
                    mode: "investigate",
                    state: "finished",
                    summary:
                        "The settings tests expect the old default of the theme.\n\nTicket: Update the theme " +
                        "default in the settings tests\nThe default changed in ThemeWatcher.ts; the snapshots " +
                        "still have the old one.",
                    changedFiles: [],
                },
            },
            {
                id: "3",
                title: "Prepare the demo",
                details: "",
                done: false,
                date: "Sun, 8 Nov, 18:15",
                canOpenChat: false,
                run: { mode: "implement", state: "running", changedFiles: [] },
            },
        ],
        setFilter: fn(),
        addTask: fn(),
        setDone: fn(),
        deleteTask: fn(),
        openChat: fn(),
        runTask: fn(),
    },
} satisfies Meta<typeof AgentTodoViewWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Implemented: Story = {
    args: {
        items: [
            {
                id: "4",
                title: "Fix the typo on the login page",
                details: "Dave: it says 'Sign inn'.",
                done: false,
                sender: "Dave",
                chatName: "Dave",
                date: "Mon, 9 Nov, 09:30",
                canOpenChat: true,
                run: {
                    mode: "implement",
                    state: "finished",
                    summary: "Fixed the label in the login form. Nothing is committed.",
                    changedFiles: ["src/components/LoginForm.tsx", "src/i18n/strings/en_EN.json"],
                },
            },
            {
                id: "5",
                title: "Review the release notes",
                details: "",
                done: false,
                sender: "Erin",
                chatName: "Release",
                date: "Mon, 9 Nov, 08:00",
                canOpenChat: true,
                run: { mode: "investigate", state: "failed", error: "rate_limited", changedFiles: [] },
            },
        ],
    },
};

export const WithoutWorkspace: Story = {
    args: { canRun: false },
};

export const Empty: Story = {
    args: { items: [], openCount: 0 },
};

export const Done: Story = {
    args: {
        filter: "done",
        items: [
            {
                id: "6",
                title: "Send the slides",
                details: "",
                done: true,
                sender: "Bob",
                chatName: "Team",
                date: "Fri, 6 Nov, 16:20",
                canOpenChat: true,
            },
        ],
    },
};
