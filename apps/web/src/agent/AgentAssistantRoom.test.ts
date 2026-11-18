/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach, type Mocked } from "vitest";
import {
    type IRoomTimelineData,
    type MatrixClient,
    type MatrixEvent,
    type Room,
    RoomEvent,
} from "matrix-js-sdk/src/matrix";
import { mkMessage, stubClient } from "test-utils";

import { AgentAssistantRoom, ASSISTANT_ROOM_ACCOUNT_DATA } from "./AgentAssistantRoom";
import type { AgentApi } from "./AgentApi";
import { AgentTaskStore } from "./AgentTaskStore";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";

const ROOM_ID = "!pilot:example.org";
const LIVE = { liveEvent: true } as IRoomTimelineData;

describe("AgentAssistantRoom", () => {
    let client: MatrixClient;
    let agent: Mocked<Pick<AgentApi, "assistantChat">>;
    let store: AgentTaskStore;
    let assistant: AgentAssistantRoom;
    let roomIdInAccountData: string | undefined;
    let timeline: MatrixEvent[];
    let room: Room;

    /** A message in the chat with the agent */
    function message(body: string, { fromAgent = false, sender = client.getSafeUserId() } = {}): MatrixEvent {
        const event = mkMessage({ room: ROOM_ID, user: sender, msg: body, event: true });
        if (fromAgent) event.getContent()[AGENT_MESSAGE_KEY] = true;
        timeline.push(event);
        return event;
    }

    function receive(event: MatrixEvent, roomOfEvent: Room = room): void {
        client.emit(RoomEvent.Timeline, event, roomOfEvent, false, false, LIVE);
    }

    /** The messages the agent sent, by room */
    function sent(): [string, Record<string, unknown>][] {
        return vi.mocked(client.sendMessage).mock.calls as unknown as [string, Record<string, unknown>][];
    }

    beforeEach(() => {
        client = stubClient();
        roomIdInAccountData = ROOM_ID;
        timeline = [];
        room = {
            roomId: ROOM_ID,
            getMyMembership: () => "join",
            getLiveTimeline: () => ({ getEvents: () => timeline }),
            getMember: () => ({ name: "Alice" }),
        } as unknown as Room;
        vi.mocked(client.getAccountData).mockImplementation(((type: string) =>
            type === ASSISTANT_ROOM_ACCOUNT_DATA && roomIdInAccountData
                ? { getContent: () => ({ room_id: roomIdInAccountData }) }
                : undefined) as never);
        vi.mocked(client.getRoom).mockImplementation((roomId) => (roomId === ROOM_ID ? room : null));
        vi.mocked(client.createRoom).mockResolvedValue({ room_id: ROOM_ID });
        vi.mocked(client.setAccountData).mockImplementation(async (_type, content) => {
            roomIdInAccountData = (content as { room_id: string }).room_id;
            return {};
        });
        agent = { assistantChat: vi.fn().mockResolvedValue({ ok: true, data: { text: "Done.", tasksChanged: false } }) };
        store = new AgentTaskStore();
        vi.spyOn(store, "reload").mockResolvedValue();
        assistant = new AgentAssistantRoom();
        assistant.start(client, agent as unknown as AgentApi, store);
    });

    afterEach(() => {
        assistant.stop();
        vi.restoreAllMocks();
    });

    it("answers the user with the latest messages, marked as written by the agent", async () => {
        message("Hi");
        message("Hello! How can I help?", { fromAgent: true });
        receive(message("What's open?"));

        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
        expect(agent.assistantChat).toHaveBeenCalledWith({
            userId: client.getSafeUserId(),
            ownName: "Alice",
            turns: [
                { role: "user", text: "Hi" },
                { role: "assistant", text: "Hello! How can I help?" },
                { role: "user", text: "What's open?" },
            ],
        });
        const [roomId, content] = sent()[0];
        expect(roomId).toBe(ROOM_ID);
        expect(content).toMatchObject({ body: "Done.", [AGENT_MESSAGE_KEY]: true });
        expect(client.sendTyping).toHaveBeenCalledWith(ROOM_ID, true, expect.any(Number));
        expect(client.sendTyping).toHaveBeenLastCalledWith(ROOM_ID, false, 0);
        expect(store.reload).not.toHaveBeenCalled();
    });

    it("sends Markdown as HTML and reads the to-do list again when the agent changed it", async () => {
        agent.assistantChat.mockResolvedValue({ ok: true, data: { text: "Added **Call Bob**.", tasksChanged: true } });

        receive(message("Remind me to call Bob"));

        await vi.waitFor(() => expect(store.reload).toHaveBeenCalled());
        expect(sent()[0][1].formatted_body).toContain("<strong>Call Bob</strong>");
    });

    it("answers each message once, one after another", async () => {
        let finish: () => void = () => {};
        agent.assistantChat.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = () => resolve({ ok: true, data: { text: "First.", tasksChanged: false } });
                }),
        );
        const first = message("One");
        receive(first);
        receive(first);
        receive(message("Two"));
        await vi.waitFor(() => expect(agent.assistantChat).toHaveBeenCalledTimes(1));

        finish();

        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalledTimes(2));
        expect(sent().map(([, content]) => content.body)).toEqual(["First.", "Done."]);
    });

    it("ignores its own messages, other people and other rooms", async () => {
        receive(message("Done.", { fromAgent: true }));
        receive(message("Hi", { sender: "@bob:example.org" }));
        receive(
            mkMessage({ room: "!other:example.org", user: client.getSafeUserId(), msg: "Hi", event: true }),
            { roomId: "!other:example.org" } as Room,
        );
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(agent.assistantChat).not.toHaveBeenCalled();
    });

    it("tells the user why it couldn't answer", async () => {
        agent.assistantChat.mockResolvedValue({ ok: false, error: "not_connected" });

        receive(message("Hi"));

        await vi.waitFor(() => expect(client.sendMessage).toHaveBeenCalled());
        expect(sent()[0][1].body).toContain("no AI provider is connected");
    });

    it("creates the chat once, remembers it and greets the user", async () => {
        roomIdInAccountData = undefined;

        const [first, second] = await Promise.all([assistant.ensureRoom(), assistant.ensureRoom()]);

        expect([first, second]).toEqual([ROOM_ID, ROOM_ID]);
        expect(client.createRoom).toHaveBeenCalledTimes(1);
        expect(client.createRoom).toHaveBeenCalledWith(expect.objectContaining({ name: "Element Pilot" }));
        expect(client.setAccountData).toHaveBeenCalledWith(ASSISTANT_ROOM_ACCOUNT_DATA, { room_id: ROOM_ID });
        expect(sent()[0][1][AGENT_MESSAGE_KEY]).toBe(true);
    });

    it("shows the chat", async () => {
        const dispatch = vi.spyOn(defaultDispatcher, "dispatch");

        expect(await assistant.openRoom()).toBe(true);

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ action: Action.ViewRoom, room_id: ROOM_ID }));
        expect(client.createRoom).not.toHaveBeenCalled();
    });

    it("has no chat without an agent", async () => {
        assistant.start(client, undefined, store);

        expect(assistant.isAvailable).toBe(false);
        expect(await assistant.ensureRoom()).toBeUndefined();
    });
});
