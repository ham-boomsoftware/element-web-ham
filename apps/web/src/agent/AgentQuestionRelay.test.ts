/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
    type IRoomTimelineData,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    RoomEvent,
} from "matrix-js-sdk/src/matrix";
import { mkMessage, stubClient } from "test-utils";
import type { AgentTask } from "shared-types";

import { AgentQuestionRelay } from "./AgentQuestionRelay";
import { AgentTaskStore, AgentTaskStoreEvent } from "./AgentTaskStore";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";
import DMRoomMap from "../utils/DMRoomMap";

const DM_ID = "!dm:example.org";
const GROUP_ID = "!team:example.org";
const BOB = "@bob:example.org";
const LIVE = { liveEvent: true } as IRoomTimelineData;

/** A task the agent works on, with a question that waits for its answer */
function asking(id: string, roomId: string, question = "Which logo?", askedAt = 1): AgentTask {
    return {
        id,
        title: "Add the logo",
        details: "",
        done: false,
        createdAt: 1,
        source: { roomId, roomName: "Bob", sender: BOB, eventId: `$ask-${id}` },
        run: { mode: "autopilot", state: "running", startedAt: 1, question: { text: question, askedAt } },
    };
}

describe("AgentQuestionRelay", () => {
    let client: MatrixClient;
    let store: AgentTaskStore;
    let tasks: AgentTask[];
    let relay: AgentQuestionRelay;
    let sent: number;

    function setTasks(next: AgentTask[]): void {
        tasks = next;
        store.emit(AgentTaskStoreEvent.Update);
    }

    /** A live message in a room */
    function receive(roomId: string, sender: string, body: string, replyTo?: string): MatrixEvent {
        const event = mkMessage({ room: roomId, user: sender, msg: body, event: true });
        if (replyTo) event.getContent()["m.relates_to"] = { "m.in_reply_to": { event_id: replyTo } };
        client.emit(RoomEvent.Timeline, event, { roomId } as Room, false, false, LIVE);
        return event;
    }

    beforeEach(() => {
        client = stubClient();
        sent = 0;
        vi.mocked(client.sendMessage).mockImplementation(async () => ({ event_id: `$question-${++sent}` }));
        DMRoomMap.setShared({
            getUserIdForRoomId: (roomId: string) => (roomId === DM_ID ? BOB : undefined),
        } as unknown as DMRoomMap);
        store = new AgentTaskStore();
        tasks = [];
        vi.spyOn(store, "tasks", "get").mockImplementation(() => tasks);
        vi.spyOn(store, "answerQuestion").mockResolvedValue(undefined);
        relay = new AgentQuestionRelay();
        relay.start(client, store);
    });

    afterEach(() => {
        relay.stop();
        store.stop();
        vi.restoreAllMocks();
    });

    it("asks the question in the chat of the task, once, as a marked reply to the request", async () => {
        setTasks([asking("1", GROUP_ID)]);
        setTasks([asking("1", GROUP_ID)]);

        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(1));
        const [roomId, content] = vi.mocked(client.sendMessage).mock.calls[0] as unknown as [
            string,
            Record<string, unknown>,
        ];
        expect(roomId).toBe(GROUP_ID);
        expect(content.body).toContain("Which logo?");
        expect(content[AGENT_MESSAGE_KEY]).toBe(true);
        expect(content["m.relates_to"]).toEqual({ "m.in_reply_to": { event_id: "$ask-1" } });
    });

    it("asks a later question about the same task again", async () => {
        setTasks([asking("1", GROUP_ID)]);
        setTasks([asking("1", GROUP_ID, "And the size?", 2)]);

        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2));
    });

    it("asks nothing for tasks without a chat, answered questions, or runs that ended", () => {
        const { source: _, ...withoutChat } = asking("1", GROUP_ID);
        const answered = asking("2", GROUP_ID);
        answered.run!.question!.answer = "";
        const ended = asking("3", GROUP_ID);
        ended.run!.state = "failed";

        setTasks([withoutChat, answered, ended]);

        expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it("gives the agent a reply to the question as the answer, without its reply fallback", async () => {
        setTasks([asking("1", GROUP_ID)]);
        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());

        const reply = receive(GROUP_ID, BOB, "> <@alice:example.org> Which logo?\n\nThe white one", "$question-1");

        await vi.waitFor(() => expect(store.answerQuestion).toHaveBeenCalledWith("1", "The white one", BOB));
        expect(relay.isAnswer(reply)).toBe(true);
    });

    it("doesn't take other messages of a group chat as the answer", async () => {
        setTasks([asking("1", GROUP_ID)]);
        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());

        const other = receive(GROUP_ID, BOB, "Lunch?");
        await Promise.resolve();

        expect(store.answerQuestion).not.toHaveBeenCalled();
        expect(relay.isAnswer(other)).toBe(false);
    });

    it("takes the next message of the other person in a direct chat as the answer", async () => {
        setTasks([asking("1", DM_ID)]);
        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());

        receive(DM_ID, client.getSafeUserId(), "Let me think");
        receive(DM_ID, BOB, "The white one");

        await vi.waitFor(() => expect(store.answerQuestion).toHaveBeenCalledTimes(1));
        expect(store.answerQuestion).toHaveBeenCalledWith("1", "The white one", BOB);
    });

    it("takes only the first answer", async () => {
        setTasks([asking("1", DM_ID)]);
        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());

        receive(DM_ID, BOB, "The white one");
        receive(DM_ID, BOB, "Thanks!");

        await vi.waitFor(() => expect(store.answerQuestion).toHaveBeenCalled());
        await Promise.resolve();
        expect(store.answerQuestion).toHaveBeenCalledTimes(1);
    });

    it("stops asking and reading when stopped", async () => {
        relay.stop();

        setTasks([asking("1", DM_ID)]);
        receive(DM_ID, BOB, "The white one");
        await Promise.resolve();

        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(store.answerQuestion).not.toHaveBeenCalled();
    });
});
