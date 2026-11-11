/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { render, screen, within } from "@test-utils";
import { composeStories } from "@storybook/react-vite";
import React from "react";
import userEvent from "@testing-library/user-event";
import { describe, it, vi, expect } from "vitest";

import * as stories from "./AgentTodoView.stories";
import {
    AgentTodoView,
    type AgentTodoRun,
    type AgentTodoViewActions,
    type AgentTodoViewSnapshot,
} from "./AgentTodoView";
import { MockViewModel } from "../../core/viewmodel/MockViewModel";

const {
    Default,
    Implemented,
    WithoutWorkspace,
    Empty,
    Done,
    AutopilotRunning,
    AutopilotFinished,
    AutopilotPushFailed,
} = composeStories(stories);

class TestViewModel extends MockViewModel<AgentTodoViewSnapshot> implements AgentTodoViewActions {
    public setFilter = vi.fn();
    public addTask = vi.fn();
    public setDone = vi.fn();
    public deleteTask = vi.fn();
    public openChat = vi.fn();
    public runTask = vi.fn();
    public selectProject = vi.fn();
    public chooseProject = vi.fn();
    public openInCli = vi.fn();
    public toggleDiff = vi.fn();
    public openWorktree = vi.fn();
    public continueInCli = vi.fn();
    public removeWorktree = vi.fn();
    public reportToChat = vi.fn();
}

const SNAPSHOT: AgentTodoViewSnapshot = {
    filter: "open",
    openCount: 1,
    doneCount: 0,
    canRun: true,
    projects: ["/work/app", "/work/api"],
    project: "/work/app",
    cli: "claude",
    items: [
        {
            id: "task-1",
            title: "Create a ticket",
            details: "For the login bug",
            done: false,
            sender: "Bob",
            chatName: "Team",
            date: "Mon, 9 Nov, 12:40",
            canOpenChat: true,
        },
    ],
};

describe("AgentTodoView", () => {
    describe("Storybook snapshots", () => {
        it.each([
            ["the open tasks", Default],
            ["the reports of the agent", Implemented],
            ["the list without a workspace", WithoutWorkspace],
            ["an empty list", Empty],
            ["the done tasks", Done],
            ["the autopilot at work", AutopilotRunning],
            ["what the autopilot did", AutopilotFinished],
            ["a branch that couldn't be pushed", AutopilotPushFailed],
        ])("renders %s", (_, Story) => {
            const { container } = render(<Story />);
            expect(container).toMatchSnapshot();
        });
    });

    it("shows each task with who asked for it, and the filters with their counts", () => {
        render(<Default />);

        const list = screen.getByRole("list", { name: "To-do list" });
        expect(list.querySelectorAll(":scope > li")).toHaveLength(3);
        expect(screen.getByText("Bob in Team · Mon, 9 Nov, 12:40")).toBeInTheDocument();
        expect(screen.getByText("Added by you · Sun, 8 Nov, 18:15")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Open (3)" })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Done (1)" })).toHaveAttribute("aria-pressed", "false");
    });

    it("shows that the agent is working, and its report", () => {
        render(<Default />);

        expect(screen.getByText("The agent is working on it…")).toBeInTheDocument();
        expect(screen.getByText("What the agent found")).toBeInTheDocument();
        expect(screen.getByText(/The settings tests expect the old default/)).toBeInTheDocument();
    });

    it("shows the changed files and why a run failed", () => {
        render(<Implemented />);

        expect(screen.getByText("src/components/LoginForm.tsx")).toBeInTheDocument();
        expect(screen.getByText(/The provider is limiting requests/)).toBeInTheDocument();
    });

    it("asks for a workspace to look into tasks, but still lets them be done in a CLI", () => {
        render(<WithoutWorkspace />);

        expect(screen.getByText(/Choose a project folder in the agent settings/)).toBeInTheDocument();
        for (const button of screen.getAllByRole("button", { name: "Look into it" })) expect(button).toBeDisabled();
        for (const button of screen.getAllByRole("button", { name: "Do it" })) expect(button).toBeEnabled();
    });

    it("says when there is nothing to do", () => {
        render(<Empty />);

        expect(screen.getByText("Nothing to do. Requests from your chats show up here.")).toBeInTheDocument();
    });

    it("passes the actions of a task to the view model", async () => {
        const user = userEvent.setup();
        const vm = new TestViewModel(SNAPSHOT);
        render(<AgentTodoView vm={vm} />);

        await user.click(screen.getByRole("checkbox", { name: "Mark Create a ticket as done" }));
        expect(vm.setDone).toHaveBeenCalledWith("task-1", true);
        await user.click(screen.getByRole("button", { name: "Open chat" }));
        expect(vm.openChat).toHaveBeenCalledWith("task-1");
        await user.click(screen.getByRole("button", { name: "Look into it" }));
        expect(vm.runTask).toHaveBeenCalledWith("task-1", "investigate");
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(vm.deleteTask).toHaveBeenCalledWith("task-1");
        await user.click(screen.getByRole("button", { name: "Done (0)" }));
        expect(vm.setFilter).toHaveBeenCalledWith("done");
    });

    it("opens a task in Claude Code, in the chosen project and with the user's prompt", async () => {
        const user = userEvent.setup();
        const vm = new TestViewModel(SNAPSHOT);
        render(<AgentTodoView vm={vm} />);
        const doIt = screen.getByRole("button", { name: "Do it" });
        expect(doIt).toHaveAttribute("aria-expanded", "false");

        await user.click(doIt);

        const form = screen.getByRole("form", { name: "Do it in a coding CLI" });
        const project = within(form).getByRole("combobox", { name: "Project" });
        expect(project).toHaveValue("/work/app");
        await user.selectOptions(project, "/work/api");
        expect(vm.selectProject).toHaveBeenCalledWith("/work/api");
        await user.type(within(form).getByRole("textbox", { name: "Your prompt (optional)" }), " Add a test ");
        await user.click(within(form).getByRole("button", { name: "Open in Claude Code" }));
        expect(vm.openInCli).toHaveBeenCalledWith("task-1", "Add a test");

        await user.click(within(form).getByRole("button", { name: "Cancel" }));
        expect(screen.queryByRole("form", { name: "Do it in a coding CLI" })).not.toBeInTheDocument();
    });

    it("lets the user choose another folder", async () => {
        const user = userEvent.setup();
        const vm = new TestViewModel(SNAPSHOT);
        render(<AgentTodoView vm={vm} />);
        await user.click(screen.getByRole("button", { name: "Do it" }));

        await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "Other folder…");

        expect(vm.chooseProject).toHaveBeenCalled();
        expect(vm.selectProject).not.toHaveBeenCalled();
    });

    it("asks for a folder when there is no project yet, and offers Copilot CLI when it is chosen", async () => {
        const user = userEvent.setup();
        const vm = new TestViewModel({ ...SNAPSHOT, projects: [], project: undefined, cli: "copilot" });
        render(<AgentTodoView vm={vm} />);
        await user.click(screen.getByRole("button", { name: "Do it" }));

        expect(screen.getByText("Choose the project folder to work in.")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Open in Copilot CLI" })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: "Choose folder…" }));
        expect(vm.chooseProject).toHaveBeenCalled();
    });

    it.each([
        [{ id: "task-1", state: "opened" as const }, "status", "Opened in a new terminal"],
        [
            { id: "task-1", state: "failed" as const, error: "folder_missing" as const },
            "alert",
            "doesn't exist any more",
        ],
        [{ id: "task-1", state: "failed" as const }, "alert", "Check that the CLI is installed"],
    ])("shows how opening went: %j", async (launch, role, text) => {
        const user = userEvent.setup();
        const vm = new TestViewModel({ ...SNAPSHOT, launch });
        render(<AgentTodoView vm={vm} />);
        await user.click(screen.getByRole("button", { name: "Do it" }));

        expect(screen.getByRole(role).textContent).toContain(text);
    });

    it("adds a task the user writes", async () => {
        const user = userEvent.setup();
        const vm = new TestViewModel(SNAPSHOT);
        render(<AgentTodoView vm={vm} />);
        const input = screen.getByRole("textbox", { name: "New task" });
        expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

        await user.type(input, "  Call Dave {Enter}");

        expect(vm.addTask).toHaveBeenCalledWith("Call Dave");
        expect(input).toHaveValue("");
    });

    it("doesn't offer the agent's actions for a done task", () => {
        const vm = new TestViewModel({ ...SNAPSHOT, items: [{ ...SNAPSHOT.items[0], done: true }] });
        render(<AgentTodoView vm={vm} />);

        expect(screen.getByRole("checkbox", { name: "Mark Create a ticket as not done" })).toBeChecked();
        expect(screen.queryByRole("button", { name: "Look into it" })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Autopilot" })).not.toBeInTheDocument();
    });

    describe("the autopilot", () => {
        const autopilotRun = (overrides: Partial<AgentTodoRun> = {}): AgentTodoRun => ({
            mode: "autopilot",
            state: "finished",
            summary: "Fixed it.",
            changedFiles: ["a.ts"],
            steps: [],
            branch: { name: "pilot/fix-abc123", base: "main", commit: "3f9e2a1", pushed: true, hasWorktree: true },
            ...overrides,
        });
        const withRun = (run: AgentTodoRun, extra: Partial<AgentTodoViewSnapshot> = {}): AgentTodoViewSnapshot => ({
            ...SNAPSHOT,
            ...extra,
            items: [{ ...SNAPSHOT.items[0], run, chatReport: "Done: fixed it." }],
        });

        it("starts the autopilot on a task", async () => {
            const user = userEvent.setup();
            const vm = new TestViewModel(SNAPSHOT);
            render(<AgentTodoView vm={vm} />);

            await user.click(screen.getByRole("button", { name: "Autopilot" }));

            expect(vm.runTask).toHaveBeenCalledWith("task-1", "autopilot");
        });

        it("shows the steps as they happen, with the latest as the current one", () => {
            render(<AutopilotRunning />);

            expect(screen.getByText("The autopilot is working on it…")).toBeInTheDocument();
            const steps = within(screen.getByRole("list", { name: "Steps of the agent" })).getAllByRole("listitem");
            expect(steps).toHaveLength(5);
            expect(steps[4]).toHaveAttribute("aria-current", "step");
            expect(steps[4].textContent).toContain("pnpm install");
            expect(screen.queryByRole("button", { name: "Show changes" })).not.toBeInTheDocument();
        });

        it("shows only the latest steps until all are asked for", async () => {
            const user = userEvent.setup();
            render(<AutopilotFinished />);
            const list = screen.getByRole("list", { name: "Steps of the agent" });
            expect(within(list).getAllByRole("listitem")).toHaveLength(6);
            expect(within(list).queryByRole("listitem", { current: "step" })).not.toBeInTheDocument();

            await user.click(screen.getByRole("button", { name: "Show all 10 steps" }));

            expect(within(list).getAllByRole("listitem")).toHaveLength(10);
        });

        it("shows the branch, its commit, the push and a link to a pull request", () => {
            render(<AutopilotFinished />);

            const branch = screen.getByRole("group", { name: "Branch of the autopilot" });
            expect(within(branch).getByText("pilot/fix-the-typo-a1b2c3")).toBeInTheDocument();
            expect(within(branch).getByText("from main")).toBeInTheDocument();
            expect(within(branch).getByText("3f9e2a1")).toBeInTheDocument();
            expect(within(branch).getByText("Pushed")).toBeInTheDocument();
            expect(within(branch).getByRole("link", { name: "Open pull request" })).toHaveAttribute(
                "href",
                "https://github.com/example/app/compare/main...pilot/fix-the-typo-a1b2c3",
            );
        });

        it("shows why a branch couldn't be pushed", () => {
            render(<AutopilotPushFailed />);

            expect(screen.getByText("Not pushed")).toBeInTheDocument();
            expect(screen.getByText("remote: Permission to example/app.git denied.")).toBeInTheDocument();
            expect(screen.queryByRole("link", { name: "Open pull request" })).not.toBeInTheDocument();
        });

        it("shows the changes per file with what was added and removed", () => {
            render(<AutopilotFinished />);

            const changes = screen.getByRole("region", { name: "Changes of the autopilot" });
            expect(within(changes).getByText("2 files changed")).toBeInTheDocument();
            expect(within(changes).getByText("src/components/LoginForm.test.tsx")).toBeInTheDocument();
            expect(
                within(changes)
                    .getByText(/Sign inn/)
                    .closest("[data-type]"),
            ).toHaveAttribute("data-type", "remove");
            expect(screen.getByRole("button", { name: "Hide changes" })).toHaveAttribute("aria-expanded", "true");
        });

        it.each([
            ["loading", "Loading the changes…"],
            ["failed", "The changes couldn't be loaded."],
            ["loaded", "No changes."],
        ] as const)("says when the changes are %s", (state, text) => {
            const vm = new TestViewModel(withRun(autopilotRun(), { diff: { id: "task-1", state, files: [] } }));
            render(<AgentTodoView vm={vm} />);

            expect(screen.getByText(text)).toBeInTheDocument();
        });

        it("passes the actions of the branch to the view model", async () => {
            const user = userEvent.setup();
            const vm = new TestViewModel(withRun(autopilotRun()));
            render(<AgentTodoView vm={vm} />);

            await user.click(screen.getByRole("button", { name: "Show changes" }));
            expect(vm.toggleDiff).toHaveBeenCalledWith("task-1");
            await user.click(screen.getByRole("button", { name: "Open folder" }));
            expect(vm.openWorktree).toHaveBeenCalledWith("task-1");
            await user.click(screen.getByRole("button", { name: "Continue in the CLI" }));
            expect(vm.continueInCli).toHaveBeenCalledWith("task-1");
            await user.click(screen.getByRole("button", { name: "Remove worktree" }));
            expect(vm.removeWorktree).toHaveBeenCalledWith("task-1");
        });

        it("offers no worktree actions once the worktree is gone", () => {
            const run = autopilotRun();
            const vm = new TestViewModel(withRun({ ...run, branch: { ...run.branch!, hasWorktree: false } }));
            render(<AgentTodoView vm={vm} />);

            expect(screen.getByRole("button", { name: "Show changes" })).toBeInTheDocument();
            expect(screen.queryByRole("button", { name: "Open folder" })).not.toBeInTheDocument();
        });

        it("says which project isn't a git repository", () => {
            const vm = new TestViewModel(
                withRun(autopilotRun({ state: "failed", error: "no_repository", branch: undefined })),
            );
            render(<AgentTodoView vm={vm} />);

            expect(screen.getByText(/isn't in a git repository/)).toBeInTheDocument();
        });

        it("tells the chat what was done, with the text the user changed", async () => {
            const user = userEvent.setup();
            const vm = new TestViewModel(withRun(autopilotRun()));
            render(<AgentTodoView vm={vm} />);

            await user.click(screen.getByRole("button", { name: "Tell the chat" }));
            const text = screen.getByRole("textbox", { name: "Message to the chat" });
            expect(text).toHaveValue("Done: fixed it.");
            await user.type(text, " Please review.");
            await user.click(screen.getByRole("button", { name: "Send" }));

            expect(vm.reportToChat).toHaveBeenCalledWith("task-1", "Done: fixed it. Please review.");
        });

        it.each([
            ["sent", "status", "Sent to the chat."],
            ["failed", "alert", "The message couldn't be sent. Try again."],
        ] as const)("shows that the report was %s", async (state, role, text) => {
            const user = userEvent.setup();
            const vm = new TestViewModel(withRun(autopilotRun(), { chatReport: { id: "task-1", state } }));
            render(<AgentTodoView vm={vm} />);
            if (state === "failed") await user.click(screen.getByRole("button", { name: "Tell the chat" }));

            expect(screen.getByRole(role)).toHaveTextContent(text);
        });
    });
});
