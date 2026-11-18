/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { type MatrixClient, MsgType } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import type { RoomMessageEventContent } from "matrix-js-sdk/src/types";
import type { AgentPipelineFailure, AgentTask } from "shared-types";

import type { AgentApi } from "./AgentApi";
import { AgentTaskStore } from "./AgentTaskStore";
import { AgentAssistantRoom } from "./AgentAssistantRoom";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";
import { _t } from "../languageHandler";

/** What the chat with the agent tells about a failed run, in Markdown */
export function buildFailureMessage({ build, failedSteps, analysis }: AgentPipelineFailure, task?: AgentTask): string {
    const lines = [
        _t("agent_assistant|pipeline_failed", {
            pipeline: build.pipeline,
            buildNumber: build.buildNumber,
            repository: build.repository,
            branch: build.branch,
        }),
    ];
    if (build.requestedBy && !build.own) lines.push(_t("agent_assistant|pipeline_requested_by", { name: build.requestedBy }));
    if (task) lines.push(_t("agent_assistant|pipeline_task", { title: task.title }));
    if (failedSteps.length > 0) {
        lines.push("", _t("agent_assistant|pipeline_failed_steps"), ...failedSteps.map((step) => `- ${step}`));
    }
    if (analysis) lines.push("", analysis);
    if (build.url) lines.push("", build.url);
    return lines.join("\n");
}

/** What the chat a task came from is told when the pipeline of the autopilot's branch failed */
export function buildSourceMessage({ build, analysis }: AgentPipelineFailure, task: AgentTask): string {
    const lines = [_t("agent_assistant|pipeline_failed_source", { title: task.title, branch: build.branch })];
    if (analysis) lines.push("", analysis);
    if (build.url) lines.push("", build.url);
    return lines.join("\n");
}

/**
 * Tells the user about the failed pipeline runs the platform finds: in the chat with the agent and, if the run is
 * of a branch the autopilot made for a task, also in the chat the task came from.
 */
export class AgentPipelineRelay {
    private static instance?: AgentPipelineRelay;

    private client?: MatrixClient;
    private store?: AgentTaskStore;
    private assistant?: AgentAssistantRoom;
    private stopFollowing?: () => void;

    public static sharedInstance(): AgentPipelineRelay {
        AgentPipelineRelay.instance ??= new AgentPipelineRelay();
        return AgentPipelineRelay.instance;
    }

    /**
     * Start telling the user about failed runs.
     * @param client - The client of the user
     * @param agent - The agent of the platform, which watches the pipelines; without one, nothing is told
     */
    public start(
        client: MatrixClient,
        agent: AgentApi | undefined,
        store: AgentTaskStore = AgentTaskStore.instance,
        assistant: AgentAssistantRoom = AgentAssistantRoom.sharedInstance(),
    ): void {
        this.stop();
        if (!agent) return;
        this.client = client;
        this.store = store;
        this.assistant = assistant;
        this.stopFollowing = agent.onPipelineFailure((failure) => void this.onFailure(failure));
    }

    public stop(): void {
        this.stopFollowing?.();
        this.stopFollowing = undefined;
        this.client = undefined;
        this.store = undefined;
        this.assistant = undefined;
    }

    private async onFailure(failure: AgentPipelineFailure): Promise<void> {
        const { client, store, assistant } = this;
        if (!client || !assistant) return;
        const task = store?.tasks.find((task) => task.run?.branch?.name === failure.build.branch);
        await assistant.post(buildFailureMessage(failure, task));
        if (!task?.source?.roomId || this.client !== client) return;

        const content = {
            msgtype: MsgType.Text,
            body: buildSourceMessage(failure, task),
            [AGENT_MESSAGE_KEY]: true,
            ...(task.source.eventId && { "m.relates_to": { "m.in_reply_to": { event_id: task.source.eventId } } }),
        } as RoomMessageEventContent;
        try {
            await client.sendMessage(task.source.roomId, content);
        } catch (e) {
            logger.warn(`Could not tell ${task.source.roomId} that the pipeline of the task ${task.id} failed`, e);
        }
    }
}
