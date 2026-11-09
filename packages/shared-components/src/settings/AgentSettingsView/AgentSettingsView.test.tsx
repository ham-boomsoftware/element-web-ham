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

import * as stories from "./AgentSettingsView.stories";

const { NotConnected, Connected, Copilot, InvalidCredential, Loading, WithWorkspace, MissingWorkspace } =
    composeStories(stories);

describe("<AgentSettingsView />", () => {
    beforeEach(() => {
        for (const action of [
            "setProvider",
            "connect",
            "disconnect",
            "setModel",
            "saveInstructions",
            "setReplySuggestions",
            "setTaskDetection",
            "setAutoInvestigate",
            "chooseWorkspace",
            "clearWorkspace",
        ] as const) {
            vi.mocked(NotConnected.args[action]!).mockClear();
            vi.mocked(Connected.args[action]!).mockClear();
            vi.mocked(WithWorkspace.args[action]!).mockClear();
        }
    });

    it("shows a loading state", () => {
        render(<Loading />);
        expect(screen.getByText("Loading…")).toBeInTheDocument();
    });

    it("asks for an Anthropic API key when Claude is not connected", () => {
        render(<NotConnected />);
        expect(screen.getByRole("radio", { name: "Claude" })).toBeChecked();
        expect(screen.getByLabelText("Anthropic API key")).toBeInTheDocument();
        expect(screen.queryByLabelText("Model")).not.toBeInTheDocument();
    });

    it("asks for a GitHub token when Copilot is selected", () => {
        render(<Copilot />);
        expect(screen.getByRole("radio", { name: "GitHub Copilot" })).toBeChecked();
        expect(screen.getByLabelText("GitHub token")).toBeInTheDocument();
    });

    it("connects with the typed credential", async () => {
        const user = userEvent.setup();
        render(<NotConnected />);

        const connect = screen.getByRole("button", { name: "Connect" });
        expect(connect).toBeDisabled();
        await user.type(screen.getByLabelText("Anthropic API key"), "  sk-ant-test  ");
        await user.click(connect);

        expect(NotConnected.args.connect).toHaveBeenCalledWith("sk-ant-test");
    });

    it("switches the provider", async () => {
        const user = userEvent.setup();
        render(<NotConnected />);

        await user.click(screen.getByRole("radio", { name: "GitHub Copilot" }));

        expect(NotConnected.args.setProvider).toHaveBeenCalledWith("copilot");
    });

    it("shows why the credential was not accepted", () => {
        render(<InvalidCredential />);
        expect(screen.getByText("The key or token was not accepted. Check it and try again.")).toBeInTheDocument();
    });

    it("lets a connected provider be disconnected and its model chosen", async () => {
        const user = userEvent.setup();
        render(<Connected />);

        expect(screen.getByText("Connected to Claude")).toBeInTheDocument();
        expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument();

        const model = screen.getByLabelText("Model");
        expect(model).toHaveValue("claude-sonnet-5-5");
        await user.selectOptions(model, "claude-opus-5-5");
        expect(Connected.args.setModel).toHaveBeenCalledWith("claude-opus-5-5");

        await user.click(screen.getByRole("button", { name: "Disconnect" }));
        expect(Connected.args.disconnect).toHaveBeenCalled();
    });

    it("saves changed instructions", async () => {
        const user = userEvent.setup();
        render(<Connected />);

        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toBeDisabled();
        const instructions = screen.getByLabelText("Instructions");
        await user.clear(instructions);
        await user.type(instructions, "Be brief.");
        await user.click(save);

        expect(Connected.args.saveInstructions).toHaveBeenCalledWith("Be brief.");
    });

    it("turns the reply suggestions off", async () => {
        const user = userEvent.setup();
        render(<Connected />);

        const toggle = screen.getByRole("switch", { name: "Suggest replies" });
        expect(toggle).toBeChecked();
        await user.click(toggle);

        expect(Connected.args.setReplySuggestions).toHaveBeenCalledWith(false);
    });

    it("turns collecting requests off", async () => {
        const user = userEvent.setup();
        render(<Connected />);

        const toggle = screen.getByRole("switch", { name: "Collect requests" });
        expect(toggle).toBeChecked();
        await user.click(toggle);

        expect(Connected.args.setTaskDetection).toHaveBeenCalledWith(false);
    });

    it("asks for a project folder before the agent looks into tasks by itself", async () => {
        const user = userEvent.setup();
        render(<Connected />);

        expect(screen.getByText("No folder chosen")).toBeInTheDocument();
        expect(screen.getByRole("switch", { name: "Look into new tasks by itself" })).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Choose folder…" }));

        expect(Connected.args.chooseWorkspace).toHaveBeenCalled();
    });

    it("shows the project folder, which can be removed, and looks into tasks by itself", async () => {
        const user = userEvent.setup();
        render(<WithWorkspace />);

        expect(screen.getByText("C:\\Users\\alice\\projects\\element-web")).toBeInTheDocument();
        const toggle = screen.getByRole("switch", { name: "Look into new tasks by itself" });
        expect(toggle).toBeChecked();
        await user.click(toggle);
        expect(WithWorkspace.args.setAutoInvestigate).toHaveBeenCalledWith(false);

        await user.click(screen.getByRole("button", { name: "Remove" }));
        expect(WithWorkspace.args.clearWorkspace).toHaveBeenCalled();
    });

    it("says when the project folder doesn't exist", () => {
        render(<MissingWorkspace />);
        expect(screen.getByText("This folder doesn't exist.")).toBeInTheDocument();
    });
});
