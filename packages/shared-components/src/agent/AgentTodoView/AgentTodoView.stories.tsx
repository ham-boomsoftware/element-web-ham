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
    AgentTodoView,
    type AgentTodoStep,
    type AgentTodoViewActions,
    type AgentTodoViewSnapshot,
} from "./AgentTodoView";
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
    selectProject,
    chooseProject,
    openInCli,
    toggleDiff,
    openWorktree,
    continueInCli,
    removeWorktree,
    reportToChat,
    answerQuestion,
    skipQuestion,
    ...rest
}: AgentTodoProps): JSX.Element => {
    const vm = useMockedViewModel(rest, {
        setFilter,
        addTask,
        setDone,
        deleteTask,
        openChat,
        runTask,
        selectProject,
        chooseProject,
        openInCli,
        toggleDiff,
        openWorktree,
        continueInCli,
        removeWorktree,
        reportToChat,
        answerQuestion,
        skipQuestion,
    });
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
        projects: ["C:\\projects\\element-web", "C:\\projects\\backend"],
        project: "C:\\projects\\element-web",
        cli: "claude",
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
                    steps: [
                        { kind: "search", text: "theme", time: "11:03", failed: false },
                        { kind: "read", text: "src/settings/ThemeWatcher.ts", time: "11:03", failed: false },
                    ],
                },
            },
            {
                id: "3",
                title: "Prepare the demo",
                details: "",
                done: false,
                date: "Sun, 8 Nov, 18:15",
                canOpenChat: false,
                run: { mode: "implement", state: "running", changedFiles: [], steps: [] },
            },
        ],
        setFilter: fn(),
        addTask: fn(),
        setDone: fn(),
        deleteTask: fn(),
        openChat: fn(),
        runTask: fn(),
        selectProject: fn(),
        chooseProject: fn(),
        openInCli: fn(),
        toggleDiff: fn(),
        openWorktree: fn(),
        continueInCli: fn(),
        removeWorktree: fn(),
        reportToChat: fn(),
        answerQuestion: fn(),
        skipQuestion: fn(),
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
                    steps: [],
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
                run: { mode: "investigate", state: "failed", error: "rate_limited", changedFiles: [], steps: [] },
            },
        ],
    },
};

export const WithoutWorkspace: Story = {
    args: { canRun: false },
};

const autopilotSteps: AgentTodoStep[] = [
    { kind: "list", text: ".", time: "10:02:11", failed: false },
    { kind: "search", text: "Sign inn", time: "10:02:14", failed: false },
    { kind: "read", text: "src/components/LoginForm.tsx", time: "10:02:15", failed: false },
    { kind: "edit", text: "src/components/LoginForm.tsx", time: "10:02:31", failed: false },
    { kind: "command", text: "pnpm install", time: "10:02:40", failed: false },
    { kind: "command", text: "pnpm test LoginForm", time: "10:03:12", failed: true },
    { kind: "edit", text: "src/components/LoginForm.test.tsx", time: "10:03:30", failed: false },
    { kind: "command", text: "pnpm test LoginForm", time: "10:03:58", failed: false },
];

export const AutopilotRunning: Story = {
    args: {
        items: [
            {
                id: "7",
                title: "Fix the typo on the login page",
                details: "Dave: it says 'Sign inn'.",
                done: false,
                sender: "Dave",
                chatName: "Dave",
                date: "Mon, 9 Nov, 09:30",
                canOpenChat: true,
                run: {
                    mode: "autopilot",
                    state: "running",
                    changedFiles: [],
                    steps: autopilotSteps.slice(0, 5),
                    branch: { name: "pilot/fix-the-typo-a1b2c3", base: "main", pushed: false, hasWorktree: true },
                },
            },
        ],
    },
};

export const AutopilotFinished: Story = {
    args: {
        items: [
            {
                id: "7",
                title: "Fix the typo on the login page",
                details: "Dave: it says 'Sign inn'.",
                done: false,
                sender: "Dave",
                chatName: "Dave",
                date: "Mon, 9 Nov, 09:30",
                canOpenChat: true,
                chatReport:
                    "Done: fixed the typo on the login page.\nBranch: pilot/fix-the-typo-a1b2c3\n" +
                    "Pull request: https://github.com/example/app/compare/main...pilot/fix-the-typo-a1b2c3",
                run: {
                    mode: "autopilot",
                    state: "finished",
                    summary: "Fixed the label in the login form and added a test for it.",
                    changedFiles: ["src/components/LoginForm.tsx", "src/components/LoginForm.test.tsx"],
                    steps: [
                        ...autopilotSteps,
                        { kind: "git", text: "commit 3f9e2a1", time: "10:04:01", failed: false },
                        { kind: "git", text: "push origin pilot/fix-the-typo-a1b2c3", time: "10:04:03", failed: false },
                    ],
                    branch: {
                        name: "pilot/fix-the-typo-a1b2c3",
                        base: "main",
                        commit: "3f9e2a1",
                        pushed: true,
                        pullRequestUrl: "https://github.com/example/app/compare/main...pilot/fix-the-typo-a1b2c3",
                        hasWorktree: true,
                    },
                },
            },
        ],
        diff: {
            id: "7",
            state: "loaded",
            files: [
                {
                    path: "src/components/LoginForm.tsx",
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    truncated: false,
                    lines: [
                        { type: "hunk", text: "@@ -40,7 +40,7 @@ export function LoginForm()" },
                        { type: "context", text: "         <form onSubmit={onSubmit}>" },
                        { type: "remove", text: '-            <Button type="submit">Sign inn</Button>' },
                        { type: "add", text: '+            <Button type="submit">Sign in</Button>' },
                        { type: "context", text: "         </form>" },
                    ],
                },
                {
                    path: "src/components/LoginForm.test.tsx",
                    status: "added",
                    additions: 3,
                    deletions: 0,
                    truncated: false,
                    lines: [
                        { type: "hunk", text: "@@ -0,0 +1,3 @@" },
                        { type: "add", text: '+it("says Sign in", () => {' },
                        { type: "add", text: '+    expect(render(<LoginForm />).getByText("Sign in")).toBeVisible();' },
                        { type: "add", text: "+});" },
                    ],
                },
            ],
        },
    },
};

export const AutopilotPushFailed: Story = {
    args: {
        items: [
            {
                id: "8",
                title: "Update the README",
                details: "",
                done: false,
                date: "Mon, 9 Nov, 08:00",
                canOpenChat: false,
                run: {
                    mode: "autopilot",
                    state: "finished",
                    summary: "Added the new build steps to the README.",
                    changedFiles: ["README.md"],
                    steps: [{ kind: "edit", text: "README.md", time: "08:01:10", failed: false }],
                    branch: {
                        name: "pilot/update-the-readme-d4e5f6",
                        base: "main",
                        commit: "8c1d0b7",
                        pushed: false,
                        pushError: "remote: Permission to example/app.git denied.",
                        hasWorktree: true,
                    },
                },
            },
        ],
    },
};

export const AutopilotAsking: Story = {
    args: {
        items: [
            {
                id: "9",
                title: "Add a dark logo to the login page",
                details: "Frank: the logo is hard to see in the dark theme.",
                done: false,
                sender: "Frank",
                chatName: "Design",
                date: "Mon, 9 Nov, 14:20",
                canOpenChat: true,
                run: {
                    mode: "autopilot",
                    state: "running",
                    changedFiles: [],
                    guides: ["AGENTS.md", ".github/copilot-instructions.md"],
                    steps: [
                        { kind: "guide", text: "AGENTS.md", time: "14:21:02", failed: false },
                        { kind: "guide", text: ".github/copilot-instructions.md", time: "14:21:02", failed: false },
                        { kind: "search", text: "logo", time: "14:21:05", failed: false },
                        { kind: "read", text: "src/components/AuthHeaderLogo.tsx", time: "14:21:07", failed: false },
                        {
                            kind: "ask",
                            text: "Should I use the existing logo-white.svg, or do you have a new file?",
                            time: "14:21:15",
                            failed: false,
                        },
                    ],
                    branch: { name: "pilot/add-a-dark-logo-9f8e7d", base: "main", pushed: false, hasWorktree: true },
                    question: {
                        text: "Should I use the existing logo-white.svg, or do you have a new file?",
                        state: "waiting",
                    },
                },
            },
        ],
    },
};

export const AutopilotAnswered: Story = {
    args: {
        items: [
            {
                id: "9",
                title: "Add a dark logo to the login page",
                details: "Frank: the logo is hard to see in the dark theme.",
                done: false,
                sender: "Frank",
                chatName: "Design",
                date: "Mon, 9 Nov, 14:20",
                canOpenChat: true,
                run: {
                    mode: "autopilot",
                    state: "running",
                    changedFiles: [],
                    guides: ["AGENTS.md"],
                    steps: [
                        { kind: "guide", text: "AGENTS.md", time: "14:21:02", failed: false },
                        {
                            kind: "ask",
                            text: "Should I use the existing logo-white.svg, or do you have a new file?",
                            time: "14:21:15",
                            failed: false,
                        },
                        { kind: "answer", text: "Frank: Use logo-white.svg", time: "14:24:40", failed: false },
                        { kind: "edit", text: "src/components/AuthHeaderLogo.tsx", time: "14:24:52", failed: false },
                    ],
                    branch: { name: "pilot/add-a-dark-logo-9f8e7d", base: "main", pushed: false, hasWorktree: true },
                    question: {
                        text: "Should I use the existing logo-white.svg, or do you have a new file?",
                        state: "answered",
                        answer: "Use logo-white.svg, it's already in the theme folder.",
                        answeredBy: "Frank",
                    },
                },
            },
        ],
    },
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
