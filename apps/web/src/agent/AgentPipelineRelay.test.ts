/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "test-utils";
import type { AgentPipelineFailure, AgentTask } from "shared-types";

import { AgentPipelineRelay, buildFailureMessage } from "./AgentPipelineRelay";
import type { AgentApi } from "./AgentApi";
import { AgentTaskStore } from "./AgentTaskStore";
import { AgentAssistantRoom } from "./AgentAssistantRoom";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";

const failure: AgentPipelineFailure = {
    build: {
        id: 4,
        repository: "Shop/Web",
        pipeline: "CI",
        buildNumber: "20261111.4",
        result: "failed",
        branch: "pilot/fix-login-1a2b3c",
        finishedAt: 1,
        requestedBy: "Bob",
        own: false,
        url: "https://tfs.example.com/build/4",
    },
    failedSteps: ["Run tests"],
    analysis: "A test of the login fails.",
};

const task: AgentTask = {
    id: "1a2b3c",
    title: "Fix the login",
    details: "",
    done: false,
    createdAt: 1,
    source: { roomId: "!dm:example.org", roomName: "Bob", sender: "Bob", eventId: "$request" },
    run: {
        mode: "autopilot",
        state: "finished",
        startedAt: 1,
        branch: {
            name: "pilot/fix-login-1a2b3c",
            base: "main",
            baseCommit: "abc123",
            repositoryPath: "/work",
            pushed: true,
        },
    },
};

describe("AgentPipelineRelay", () => {
    let client: MatrixClient;
    let store: AgentTaskStore;
    let assistant: AgentAssistantRoom;
    let relay: AgentPipelineRelay;
    let report: (failure: AgentPipelineFailure) => void;
    let stopFollowing: () => void;

    beforeEach(() => {
        client = stubClient();
        store = new AgentTaskStore();
        vi.spyOn(store, "tasks", "get").mockReturnValue([task]);
        assistant = new AgentAssistantRoom();
        vi.spyOn(assistant, "post").mockResolvedValue(true);
        stopFollowing = vi.fn();
        const agent = {
            onPipelineFailure: (listener: (failure: AgentPipelineFailure) => void) => {
                report = listener;
                return stopFollowing;
            },
        } as unknown as AgentApi;
        relay = new AgentPipelineRelay();
        relay.start(client, agent, store, assistant);
    });

    afterEach(() => {
        relay.stop();
        vi.restoreAllMocks();
    });

    it("tells the chat with the agent and the chat of the task about a failed run of the autopilot", async () => {
        report(failure);

        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
        expect(assistant.post).toHaveBeenCalledWith(buildFailureMessage(failure, task));
        const [roomId, content] = vi.mocked(client.sendMessage).mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ];
        expect(roomId).toBe("!dm:example.org");
        expect(content.body).toContain("Fix the login");
        expect(content[AGENT_MESSAGE_KEY]).toBe(true);
        expect(content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$request" } });
    });

    it("tells only the chat with the agent about other runs", async () => {
        report({ ...failure, build: { ...failure.build, branch: "main" } });

        await vi.waitFor(() => expect(assistant.post).toHaveBeenCalled());
        expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it("describes the run, its failed steps and the analysis", () => {
        const text = buildFailureMessage(failure, task);

        expect(text).toContain("CI 20261111.4 (Shop/Web, branch `pilot/fix-login-1a2b3c`)");
        expect(text).toContain("Started by Bob");
        expect(text).toContain('Branch of the task "Fix the login"');
        expect(text).toContain("- Run tests");
        expect(text).toContain("A test of the login fails.");
        expect(text).toContain("https://tfs.example.com/build/4");
    });

    it("stops following the failed runs", () => {
        relay.stop();

        expect(stopFollowing).toHaveBeenCalled();
    });
});
