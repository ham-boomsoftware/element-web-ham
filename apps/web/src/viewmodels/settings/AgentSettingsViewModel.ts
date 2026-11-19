/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    BaseViewModel,
    type AgentSettingsCli,
    type AgentSettingsError,
    type AgentSettingsProvider,
    type AgentSettingsViewModel as AgentSettingsViewModelInterface,
    type AgentSettingsViewSnapshot,
} from "@element-hq/web-shared-components";
import type { AgentErrorCode, AgentResult, AgentStatus } from "shared-types";

import type { AgentApi } from "../../agent/AgentApi";

export interface Props {
    /** The agent of the platform, which holds the settings and credentials */
    agent: AgentApi;
    /** Open the chat with the agent; without it, the settings offer no chat */
    onOpenAssistant?: () => void;
}

/** Turn the error of the platform into one the settings can show */
export function toSettingsError(error: AgentErrorCode): AgentSettingsError {
    switch (error) {
        case "invalid_credential":
        case "rate_limited":
        case "unavailable":
        case "no_workspace":
            return error;
        default:
            return "unknown";
    }
}

/**
 * View model of the agent settings: reads the settings from the platform's agent and changes them there.
 */

/** How often to check whether the user logged in to the Claude account of the agent */
const CLAUDE_LOGIN_POLL_MS = 3000;

/** How long to wait for the user to log in to the Claude account of the agent */
const CLAUDE_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

/** What the settings show of the login of Claude Code */
function claudeLoginOf(
    status: AgentStatus,
): Pick<AgentSettingsViewSnapshot, "claudeUsesLoggedInUser" | "claudeOwnAccount" | "claudeLogin"> {
    return {
        claudeUsesLoggedInUser: Boolean(status.claudeLoggedInUser),
        claudeOwnAccount: Boolean(status.claudeLoggedInUser?.ownAccount),
        claudeLogin: status.claudeLoggedInUser?.email,
    };
}

export class AgentSettingsViewModel
    extends BaseViewModel<AgentSettingsViewSnapshot, Props>
    implements AgentSettingsViewModelInterface
{
    public constructor(props: Props) {
        super(props, {
            isLoading: true,
            isBusy: false,
            provider: "claude",
            connected: { claude: false, copilot: false },
            copilotUsesLoggedInUser: false,
            claudeUsesLoggedInUser: false,
            claudeOwnAccount: false,
            claudeLoginPending: false,
            models: [],
            instructions: "",
            replySuggestions: true,
            taskDetection: true,
            autoInvestigate: false,
            autopilot: false,
            autopilotCommands: [],
            codingCli: "claude",
            pipelineWatch: false,
            canOpenAssistant: Boolean(props.onOpenAssistant),
        });
        void this.load();
    }

    private async load(): Promise<void> {
        const status = await this.props.agent.getStatus();
        if (this.isDisposed) return;
        const { provider, connected, model, instructions, replySuggestions, taskDetection, autoInvestigate } = status;
        this.snapshot.merge({
            isLoading: false,
            provider,
            connected,
            copilotUsesLoggedInUser: Boolean(status.copilotLoggedInUser),
            copilotLogin: status.copilotLoggedInUser?.login,
            ...claudeLoginOf(status),
            model,
            instructions,
            replySuggestions,
            taskDetection,
            autoInvestigate,
            autopilot: status.autopilot,
            autopilotCommands: status.autopilotCommands,
            workspacePath: status.workspacePath,
            codingCli: status.codingCli,
            pipelineWatch: status.pipelineWatch,
        });
        await this.loadModels();
    }

    /** Read the models of the selected provider, if it is connected */
    private async loadModels(): Promise<void> {
        const { provider, connected } = this.snapshot.current;
        if (!connected[provider]) {
            this.snapshot.merge({ models: [] });
            return;
        }
        const result = await this.props.agent.listModels(provider);
        if (this.isDisposed || this.snapshot.current.provider !== provider) return;
        if (result.ok) {
            this.snapshot.merge({ models: result.data });
        } else {
            this.snapshot.merge({ models: [], error: toSettingsError(result.error) });
        }
    }

    /**
     * Run an action of the platform's agent while the controls are disabled.
     * @returns the result, or undefined if the view model was disposed meanwhile
     */
    private async run<T>(action: () => Promise<AgentResult<T>>): Promise<AgentResult<T> | undefined> {
        this.snapshot.merge({ isBusy: true, error: undefined });
        const result = await action();
        if (this.isDisposed) return undefined;
        this.snapshot.merge({ isBusy: false, error: result.ok ? undefined : toSettingsError(result.error) });
        return result;
    }

    public setProvider = (provider: AgentSettingsProvider): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ provider }));
            if (!result?.ok) return;
            this.snapshot.merge({ provider: result.data.provider, model: result.data.model });
            await this.loadModels();
        })();
    };

    public connect = (credential: string): void => {
        const { provider } = this.snapshot.current;
        void (async () => {
            const result = await this.run(() => this.props.agent.connect(provider, credential));
            if (!result?.ok) return;
            this.snapshot.merge({
                connected: { ...this.snapshot.current.connected, [provider]: true },
                ...(provider === "copilot" && { copilotUsesLoggedInUser: false, copilotLogin: undefined }),
                ...(provider === "claude" && {
                    claudeUsesLoggedInUser: false,
                    claudeOwnAccount: false,
                    claudeLogin: undefined,
                }),
            });
            await this.loadModels();
        })();
    };

    public connectLoggedInUser = (): void => {
        void (async () => {
            const { provider } = this.snapshot.current;
            const result = await this.run(() => this.props.agent.connectLoggedInUser(provider));
            if (!result) return;
            if (!result.ok) {
                // The CLI of the provider has no login it could use on this computer
                if (result.error === "not_connected") {
                    this.snapshot.merge({ error: provider === "claude" ? "claude_not_logged_in" : "not_logged_in" });
                }
                return;
            }
            const status = await this.props.agent.getStatus();
            if (this.isDisposed) return;
            this.snapshot.merge({
                connected: status.connected,
                copilotUsesLoggedInUser: Boolean(status.copilotLoggedInUser),
                copilotLogin: status.copilotLoggedInUser?.login,
                ...claudeLoginOf(status),
            });
            await this.loadModels();
        })();
    };

    /** The timer that checks whether the user logged in to the Claude account of the agent */
    private claudeLoginTimer?: ReturnType<typeof setTimeout>;

    public loginClaudeAccount = (): void => {
        void (async () => {
            const opened = await this.run(() => this.props.agent.openClaudeLogin());
            if (!opened?.ok) return;
            this.snapshot.merge({ claudeLoginPending: true });
            const deadline = Date.now() + CLAUDE_LOGIN_TIMEOUT_MS;
            const check = async (): Promise<void> => {
                this.claudeLoginTimer = undefined;
                if (this.isDisposed || !this.snapshot.current.claudeLoginPending) return;
                // Not through run(): the controls stay usable and "not logged in yet" is no error while waiting
                const result = await this.props.agent.connectLoggedInUser("claude", "own");
                if (this.isDisposed || !this.snapshot.current.claudeLoginPending) return;
                if (result.ok) {
                    const status = await this.props.agent.getStatus();
                    if (this.isDisposed) return;
                    this.snapshot.merge({
                        claudeLoginPending: false,
                        error: undefined,
                        connected: status.connected,
                        ...claudeLoginOf(status),
                    });
                    await this.loadModels();
                } else if (Date.now() >= deadline) {
                    this.snapshot.merge({ claudeLoginPending: false, error: "claude_login_timeout" });
                } else {
                    this.claudeLoginTimer = setTimeout(() => void check(), CLAUDE_LOGIN_POLL_MS);
                }
            };
            this.claudeLoginTimer = setTimeout(() => void check(), CLAUDE_LOGIN_POLL_MS);
        })();
    };

    public cancelClaudeLogin = (): void => {
        if (this.claudeLoginTimer) clearTimeout(this.claudeLoginTimer);
        this.claudeLoginTimer = undefined;
        this.snapshot.merge({ claudeLoginPending: false });
    };

    public disconnect = (): void => {
        const { provider } = this.snapshot.current;
        void (async () => {
            const result = await this.run(() => this.props.agent.disconnect(provider));
            if (!result?.ok) return;
            this.snapshot.merge({
                connected: { ...this.snapshot.current.connected, [provider]: false },
                models: [],
                ...(provider === "copilot" && { copilotUsesLoggedInUser: false, copilotLogin: undefined }),
                ...(provider === "claude" && {
                    claudeUsesLoggedInUser: false,
                    claudeOwnAccount: false,
                    claudeLogin: undefined,
                }),
            });
        })();
    };

    public setModel = (model: string): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ model }));
            if (result?.ok) this.snapshot.merge({ model: result.data.model });
        })();
    };

    public saveInstructions = (instructions: string): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ instructions }));
            if (result?.ok) this.snapshot.merge({ instructions: result.data.instructions });
        })();
    };

    public setReplySuggestions = (replySuggestions: boolean): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ replySuggestions }));
            if (result?.ok) this.snapshot.merge({ replySuggestions: result.data.replySuggestions });
        })();
    };

    public setTaskDetection = (taskDetection: boolean): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ taskDetection }));
            if (result?.ok) this.snapshot.merge({ taskDetection: result.data.taskDetection });
        })();
    };

    public setAutoInvestigate = (autoInvestigate: boolean): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ autoInvestigate }));
            if (result?.ok) this.snapshot.merge({ autoInvestigate: result.data.autoInvestigate });
        })();
    };

    public setAutopilot = (autopilot: boolean): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ autopilot }));
            if (result?.ok) this.snapshot.merge({ autopilot: result.data.autopilot });
        })();
    };

    public saveAutopilotCommands = (autopilotCommands: string[]): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ autopilotCommands }));
            if (result?.ok) this.snapshot.merge({ autopilotCommands: result.data.autopilotCommands });
        })();
    };

    public chooseWorkspace = (): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.pickWorkspace());
            // Nothing changes when the user cancelled the folder dialog
            if (result?.ok && result.data) this.snapshot.merge({ workspacePath: result.data });
        })();
    };

    public setCodingCli = (codingCli: AgentSettingsCli): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ codingCli }));
            if (result?.ok) this.snapshot.merge({ codingCli: result.data.codingCli });
        })();
    };

    public setPipelineWatch = (pipelineWatch: boolean): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ pipelineWatch }));
            if (result?.ok) this.snapshot.merge({ pipelineWatch: result.data.pipelineWatch });
        })();
    };

    public openAssistant = (): void => {
        this.props.onOpenAssistant?.();
    };

    public clearWorkspace = (): void => {
        void (async () => {
            const result = await this.run(() => this.props.agent.setSettings({ workspacePath: "" }));
            if (result?.ok) this.snapshot.merge({ workspacePath: result.data.workspacePath });
        })();
    };
}
