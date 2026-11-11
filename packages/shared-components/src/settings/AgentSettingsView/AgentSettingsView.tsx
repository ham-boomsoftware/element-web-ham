/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import React, { type JSX, useEffect, useState } from "react";
import {
    Button,
    ErrorMessage,
    Field,
    HelpMessage,
    InlineField,
    Label,
    PasswordControl,
    RadioControl,
    Root,
    Submit,
    Text,
    ToggleControl,
} from "@vector-im/compound-web";

import { useViewModel, type ViewModel } from "../../core/viewmodel";
import { useI18n } from "../../core/i18n/i18nContext";
import { Flex } from "../../core/utils/Flex";
import styles from "./AgentSettingsView.module.css";

/**
 * The AI providers the agent can use: Claude with an Anthropic API key, or GitHub Copilot with a GitHub token or the
 * GitHub login of this computer.
 */
export type AgentSettingsProvider = "claude" | "copilot";

/**
 * The coding CLIs a task can be done with, in a terminal: Claude Code or GitHub Copilot CLI.
 */
export type AgentSettingsCli = "claude" | "copilot";

/**
 * Why the last action failed.
 * - `invalid_credential`: the provider rejected the key or token.
 * - `not_logged_in`: Copilot found no GitHub login on this computer, or the account has no Copilot plan.
 * - `rate_limited`: the provider asks to slow down, or the plan's allowance is used up.
 * - `unavailable`: the provider could not be reached.
 * - `no_workspace`: the chosen project folder doesn't exist.
 * - `unknown`: anything else.
 */
export type AgentSettingsError =
    | "invalid_credential"
    | "not_logged_in"
    | "rate_limited"
    | "unavailable"
    | "no_workspace"
    | "unknown";

/**
 * A model the selected provider offers.
 */
export interface AgentSettingsModel {
    id: string;
    /** Name for display */
    name: string;
}

export interface AgentSettingsViewSnapshot {
    /** Whether the settings are still being read */
    isLoading: boolean;
    /** Whether an action is in progress, during which the controls are disabled */
    isBusy: boolean;
    /** The provider that writes the replies */
    provider: AgentSettingsProvider;
    /** Whether a credential is stored for each provider */
    connected: Record<AgentSettingsProvider, boolean>;
    /** Whether Copilot uses the GitHub login of this computer instead of a token */
    copilotUsesLoggedInUser: boolean;
    /** The GitHub account of that login, if known */
    copilotLogin?: string;
    /** The models of the selected provider; empty while it is not connected */
    models: AgentSettingsModel[];
    /** The selected model, or undefined for the provider's default */
    model?: string;
    /** The user's own instructions for the agent */
    instructions: string;
    /** Whether replies are suggested above the composer of every chat */
    replySuggestions: boolean;
    /** Whether the agent collects requests from chats into the to-do list */
    taskDetection: boolean;
    /** Whether the agent looks into each new task in the project folder by itself */
    autoInvestigate: boolean;
    /** Whether the autopilot does each new coding task by itself, on a branch of its own */
    autopilot: boolean;
    /** The commands the autopilot may run in its worktree, exactly as written */
    autopilotCommands: string[];
    /** The folder of the project the agent works on for tasks, if one is chosen */
    workspacePath?: string;
    /** The coding CLI that "Do it" opens in a terminal */
    codingCli: AgentSettingsCli;
    /** Why the last action failed, if it did */
    error?: AgentSettingsError;
}

export interface AgentSettingsViewActions {
    /** Choose the provider that writes the replies */
    setProvider: (provider: AgentSettingsProvider) => void;
    /** Connect the selected provider with an API key or token */
    connect: (credential: string) => void;
    /** Connect Copilot with the GitHub login of this computer, of Copilot CLI or GitHub CLI */
    connectLoggedInUser: () => void;
    /** Forget the credential of the selected provider */
    disconnect: () => void;
    /** Choose a model of the selected provider, or "" for its default */
    setModel: (model: string) => void;
    /** Save the user's own instructions */
    saveInstructions: (instructions: string) => void;
    /** Turn the reply suggestions on or off */
    setReplySuggestions: (enabled: boolean) => void;
    /** Turn collecting requests into the to-do list on or off */
    setTaskDetection: (enabled: boolean) => void;
    /** Turn looking into new tasks by itself on or off */
    setAutoInvestigate: (enabled: boolean) => void;
    /** Turn doing new coding tasks with the autopilot by itself on or off */
    setAutopilot: (enabled: boolean) => void;
    /** Save the commands the autopilot may run */
    saveAutopilotCommands: (commands: string[]) => void;
    /** Let the user choose the project folder */
    chooseWorkspace: () => void;
    /** Forget the project folder */
    clearWorkspace: () => void;
    /** Choose the coding CLI that "Do it" opens */
    setCodingCli: (cli: AgentSettingsCli) => void;
}

/**
 * The view model of {@link AgentSettingsView}.
 */
export type AgentSettingsViewModel = ViewModel<AgentSettingsViewSnapshot, AgentSettingsViewActions>;

export interface AgentSettingsViewProps {
    /** The view model of the agent settings */
    vm: AgentSettingsViewModel;
}

/**
 * Settings of the agent that replies to the direct messages set to "Agent": which AI provider it uses, the
 * credential of the provider, the model, the user's own instructions, whether it suggests replies in every chat, and
 * how it keeps the to-do list: whether it collects requests from chats, and the project folder it works on them in.
 */
export function AgentSettingsView({ vm }: Readonly<AgentSettingsViewProps>): JSX.Element {
    const { translate: _t } = useI18n();
    const {
        isLoading,
        isBusy,
        provider,
        connected,
        copilotUsesLoggedInUser,
        copilotLogin,
        models,
        model,
        instructions,
        replySuggestions,
        taskDetection,
        autoInvestigate,
        autopilot,
        autopilotCommands,
        workspacePath,
        codingCli,
        error,
    } = useViewModel(vm);
    const [credential, setCredential] = useState("");
    const [instructionsDraft, setInstructionsDraft] = useState(instructions);
    const savedCommands = autopilotCommands.join("\n");
    const [commandsDraft, setCommandsDraft] = useState(savedCommands);

    // Show the saved instructions once they are loaded
    useEffect(() => setInstructionsDraft(instructions), [instructions]);
    useEffect(() => setCommandsDraft(savedCommands), [savedCommands]);
    // A credential typed for one provider is never sent to the other
    useEffect(() => setCredential(""), [provider]);

    if (isLoading) return <Text>{_t("common|loading")}</Text>;

    // One command per line; blank lines and surrounding spaces don't count
    const draftCommands = commandsDraft
        .split("\n")
        .map((command) => command.trim())
        .filter(Boolean);

    const isConnected = connected[provider];
    // The keys are written out so that the translation tooling finds them
    const providerNames: Record<AgentSettingsProvider, string> = {
        claude: _t("settings|agent|provider_claude"),
        copilot: _t("settings|agent|provider_copilot"),
    };
    const connectedLabels: Record<AgentSettingsProvider, string> = {
        claude: _t("settings|agent|connected_claude"),
        copilot: _t("settings|agent|connected_copilot"),
    };
    if (copilotUsesLoggedInUser) {
        connectedLabels.copilot = copilotLogin
            ? _t("settings|agent|connected_copilot_login", { login: copilotLogin })
            : _t("settings|agent|connected_copilot_logged_in");
    }
    const credentialLabels: Record<AgentSettingsProvider, string> = {
        claude: _t("settings|agent|credential_claude"),
        copilot: _t("settings|agent|credential_copilot"),
    };
    const credentialHelp: Record<AgentSettingsProvider, string> = {
        claude: _t("settings|agent|credential_help_claude"),
        copilot: _t("settings|agent|credential_help_copilot"),
    };
    const errorMessages: Record<AgentSettingsError, string> = {
        invalid_credential: _t("settings|agent|error_invalid_credential"),
        not_logged_in: _t("settings|agent|error_not_logged_in"),
        rate_limited: _t("settings|agent|error_rate_limited"),
        unavailable: _t("settings|agent|error_unavailable"),
        no_workspace: _t("settings|agent|error_no_workspace"),
        unknown: _t("settings|agent|error_unknown"),
    };
    // A missing project folder is shown next to the folder, the other errors next to the provider
    const errorMessage = error && error !== "no_workspace" ? errorMessages[error] : undefined;

    return (
        <Flex direction="column" gap="var(--cpd-space-6x)" className={styles.agentSettings}>
            <Text size="sm" className={styles.description}>
                {_t("settings|agent|description")}
            </Text>

            <Root onSubmit={(ev) => ev.preventDefault()}>
                <Text as="h3" size="md" weight="semibold">
                    {_t("settings|agent|provider")}
                </Text>
                {(["claude", "copilot"] as const).map((option) => (
                    <InlineField
                        key={option}
                        name="provider"
                        control={
                            <RadioControl
                                value={option}
                                checked={provider === option}
                                disabled={isBusy}
                                onChange={() => vm.setProvider(option)}
                            />
                        }
                    >
                        <Label>{providerNames[option]}</Label>
                    </InlineField>
                ))}
            </Root>

            {isConnected ? (
                <Flex align="center" justify="space-between" gap="var(--cpd-space-4x)">
                    <Text size="md">{connectedLabels[provider]}</Text>
                    <Button kind="secondary" size="md" disabled={isBusy} onClick={vm.disconnect}>
                        {_t("settings|agent|disconnect")}
                    </Button>
                </Flex>
            ) : (
                <Root
                    onSubmit={(ev) => {
                        ev.preventDefault();
                        if (credential.trim()) vm.connect(credential.trim());
                    }}
                >
                    <Field name="credential">
                        <Label>{credentialLabels[provider]}</Label>
                        <PasswordControl
                            value={credential}
                            disabled={isBusy}
                            autoComplete="off"
                            onChange={(ev) => setCredential(ev.currentTarget.value)}
                        />
                        <HelpMessage>{credentialHelp[provider]}</HelpMessage>
                        {errorMessage && <ErrorMessage>{errorMessage}</ErrorMessage>}
                    </Field>
                    <Submit size="md" disabled={isBusy || !credential.trim()}>
                        {_t("settings|agent|connect")}
                    </Submit>
                    {provider === "copilot" && (
                        <Flex direction="column" gap="var(--cpd-space-2x)">
                            <Button
                                type="button"
                                kind="secondary"
                                size="md"
                                disabled={isBusy}
                                onClick={vm.connectLoggedInUser}
                            >
                                {_t("settings|agent|use_logged_in_user")}
                            </Button>
                            <Text size="sm" className={styles.description}>
                                {_t("settings|agent|use_logged_in_user_description")}
                            </Text>
                        </Flex>
                    )}
                </Root>
            )}

            {isConnected && (
                <Flex direction="column" gap="var(--cpd-space-2x)">
                    <label className={styles.label} htmlFor="mx_AgentSettings_model">
                        {_t("settings|agent|model")}
                    </label>
                    <select
                        id="mx_AgentSettings_model"
                        className={styles.control}
                        value={model ?? ""}
                        disabled={isBusy}
                        onChange={(ev) => vm.setModel(ev.currentTarget.value)}
                    >
                        <option value="">{_t("settings|agent|model_default")}</option>
                        {models.map(({ id, name }) => (
                            <option key={id} value={id}>
                                {name}
                            </option>
                        ))}
                    </select>
                    {errorMessage && (
                        <Text size="sm" className={styles.error}>
                            {errorMessage}
                        </Text>
                    )}
                </Flex>
            )}

            <Root onSubmit={(ev) => ev.preventDefault()}>
                <InlineField
                    name="replySuggestions"
                    control={
                        <ToggleControl
                            checked={replySuggestions}
                            disabled={isBusy}
                            onChange={(ev) => vm.setReplySuggestions(ev.currentTarget.checked)}
                        />
                    }
                >
                    <Label>{_t("settings|agent|reply_suggestions")}</Label>
                    <HelpMessage>{_t("settings|agent|reply_suggestions_description")}</HelpMessage>
                </InlineField>
            </Root>

            <Root onSubmit={(ev) => ev.preventDefault()}>
                <Text as="h3" size="md" weight="semibold">
                    {_t("settings|agent|tasks")}
                </Text>
                <InlineField
                    name="taskDetection"
                    control={
                        <ToggleControl
                            checked={taskDetection}
                            disabled={isBusy}
                            onChange={(ev) => vm.setTaskDetection(ev.currentTarget.checked)}
                        />
                    }
                >
                    <Label>{_t("settings|agent|task_detection")}</Label>
                    <HelpMessage>{_t("settings|agent|task_detection_description")}</HelpMessage>
                </InlineField>
                <InlineField
                    name="autoInvestigate"
                    control={
                        <ToggleControl
                            checked={autoInvestigate}
                            disabled={isBusy || !workspacePath}
                            onChange={(ev) => vm.setAutoInvestigate(ev.currentTarget.checked)}
                        />
                    }
                >
                    <Label>{_t("settings|agent|auto_investigate")}</Label>
                    <HelpMessage>{_t("settings|agent|auto_investigate_description")}</HelpMessage>
                </InlineField>
                <InlineField
                    name="autopilot"
                    control={
                        <ToggleControl
                            checked={autopilot}
                            disabled={isBusy || !workspacePath}
                            onChange={(ev) => vm.setAutopilot(ev.currentTarget.checked)}
                        />
                    }
                >
                    <Label>{_t("settings|agent|autopilot")}</Label>
                    <HelpMessage>{_t("settings|agent|autopilot_description")}</HelpMessage>
                </InlineField>
            </Root>

            <Flex direction="column" gap="var(--cpd-space-2x)">
                <Text as="span" size="md" weight="medium">
                    {_t("settings|agent|workspace")}
                </Text>
                <Flex align="center" justify="space-between" gap="var(--cpd-space-4x)">
                    <Text size="sm" className={styles.workspacePath} title={workspacePath}>
                        {workspacePath ?? _t("settings|agent|workspace_none")}
                    </Text>
                    <Flex gap="var(--cpd-space-2x)">
                        {workspacePath && (
                            <Button kind="tertiary" size="md" disabled={isBusy} onClick={vm.clearWorkspace}>
                                {_t("settings|agent|workspace_clear")}
                            </Button>
                        )}
                        <Button kind="secondary" size="md" disabled={isBusy} onClick={vm.chooseWorkspace}>
                            {_t("settings|agent|workspace_choose")}
                        </Button>
                    </Flex>
                </Flex>
                <Text size="sm" className={styles.description}>
                    {_t("settings|agent|workspace_description")}
                </Text>
                {error === "no_workspace" && (
                    <Text size="sm" className={styles.error}>
                        {errorMessages.no_workspace}
                    </Text>
                )}
            </Flex>

            <Flex direction="column" gap="var(--cpd-space-2x)">
                <label className={styles.label} htmlFor="mx_AgentSettings_autopilotCommands">
                    {_t("settings|agent|autopilot_commands")}
                </label>
                <textarea
                    id="mx_AgentSettings_autopilotCommands"
                    className={`${styles.control} ${styles.commands}`}
                    rows={4}
                    value={commandsDraft}
                    disabled={isBusy}
                    spellCheck={false}
                    placeholder={"pnpm install\npnpm test"}
                    aria-describedby="mx_AgentSettings_autopilotCommands_help"
                    onChange={(ev) => setCommandsDraft(ev.currentTarget.value)}
                />
                <Text id="mx_AgentSettings_autopilotCommands_help" size="sm" className={styles.description}>
                    {_t("settings|agent|autopilot_commands_description")}
                </Text>
                <Flex justify="end">
                    <Button
                        kind="primary"
                        size="md"
                        disabled={isBusy || draftCommands.join("\n") === savedCommands}
                        onClick={() => vm.saveAutopilotCommands(draftCommands)}
                    >
                        {_t("settings|agent|autopilot_commands_save")}
                    </Button>
                </Flex>
            </Flex>

            <Flex direction="column" gap="var(--cpd-space-2x)">
                <label className={styles.label} htmlFor="mx_AgentSettings_codingCli">
                    {_t("settings|agent|coding_cli")}
                </label>
                <select
                    id="mx_AgentSettings_codingCli"
                    className={styles.control}
                    value={codingCli}
                    disabled={isBusy}
                    onChange={(ev) => vm.setCodingCli(ev.currentTarget.value as AgentSettingsCli)}
                >
                    <option value="claude">{_t("settings|agent|coding_cli_claude")}</option>
                    <option value="copilot">{_t("settings|agent|coding_cli_copilot")}</option>
                </select>
                <Text size="sm" className={styles.description}>
                    {_t("settings|agent|coding_cli_description")}
                </Text>
            </Flex>

            <Flex direction="column" gap="var(--cpd-space-2x)">
                <label className={styles.label} htmlFor="mx_AgentSettings_instructions">
                    {_t("settings|agent|instructions")}
                </label>
                <textarea
                    id="mx_AgentSettings_instructions"
                    className={styles.control}
                    rows={5}
                    value={instructionsDraft}
                    disabled={isBusy}
                    placeholder={_t("settings|agent|instructions_placeholder")}
                    onChange={(ev) => setInstructionsDraft(ev.currentTarget.value)}
                />
                <Flex justify="end">
                    <Button
                        kind="primary"
                        size="md"
                        disabled={isBusy || instructionsDraft === instructions}
                        onClick={() => vm.saveInstructions(instructionsDraft)}
                    >
                        {_t("action|save")}
                    </Button>
                </Flex>
            </Flex>
        </Flex>
    );
}
