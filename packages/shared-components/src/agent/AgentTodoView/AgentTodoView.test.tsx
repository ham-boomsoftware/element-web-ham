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
import { AgentTodoView, type AgentTodoViewActions, type AgentTodoViewSnapshot } from "./AgentTodoView";
import { MockViewModel } from "../../core/viewmodel/MockViewModel";

const { Default, Implemented, WithoutWorkspace, Empty, Done } = composeStories(stories);

class TestViewModel extends MockViewModel<AgentTodoViewSnapshot> implements AgentTodoViewActions {
    public setFilter = vi.fn();
    public addTask = vi.fn();
    public setDone = vi.fn();
    public deleteTask = vi.fn();
    public openChat = vi.fn();
    public runTask = vi.fn();
}

const SNAPSHOT: AgentTodoViewSnapshot = {
    filter: "open",
    openCount: 1,
    doneCount: 0,
    canRun: true,
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
        ])("renders %s", (_, Story) => {
            const { container } = render(<Story />);
            expect(container).toMatchSnapshot();
        });
    });

    it("shows each task with who asked for it, and the filters with their counts", () => {
        render(<Default />);

        const list = screen.getByRole("list", { name: "To-do list" });
        expect(within(list).getAllByRole("listitem")).toHaveLength(3);
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

    it("asks for a workspace and disables the agent's actions without one", () => {
        render(<WithoutWorkspace />);

        expect(screen.getByText(/Choose a project folder in the agent settings/)).toBeInTheDocument();
        for (const button of screen.getAllByRole("button", { name: "Look into it" })) expect(button).toBeDisabled();
        for (const button of screen.getAllByRole("button", { name: "Do it" })) expect(button).toBeDisabled();
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
        await user.click(screen.getByRole("button", { name: "Do it" }));
        expect(vm.runTask).toHaveBeenCalledWith("task-1", "implement");
        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(vm.deleteTask).toHaveBeenCalledWith("task-1");
        await user.click(screen.getByRole("button", { name: "Done (0)" }));
        expect(vm.setFilter).toHaveBeenCalledWith("done");
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
    });
});
