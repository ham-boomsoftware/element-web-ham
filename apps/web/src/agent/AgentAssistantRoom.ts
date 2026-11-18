/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    ClientEvent,
    EventType,
    type IRoomTimelineData,
    KnownMembership,
    type MatrixClient,
    type MatrixEvent,
    MsgType,
    Preset,
    RelationType,
    type Room,
    RoomEvent,
    Visibility,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import type { RoomMessageEventContent } from "matrix-js-sdk/src/types";
import type { AgentErrorCode, AgentTurn } from "shared-types";

import type { AgentApi } from "./AgentApi";
import { AgentTaskStore } from "./AgentTaskStore";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";
import { htmlSerializeFromMdIfNeeded } from "../editor/serialize";
import defaultDispatcher from "../dispatcher/dispatcher";
import { Action } from "../dispatcher/actions";
import type { ViewRoomPayload } from "../dispatcher/payloads/ViewRoomPayload";
import { _t } from "../languageHandler";

/** The account data that tells which room is the chat with the agent */
export const ASSISTANT_ROOM_ACCOUNT_DATA = "io.element.pilot.assistant_room";

/** How many of the latest messages the agent reads to answer */
const HISTORY_LENGTH = 20;
/** How long the agent shows as typing at most, in ms; it's renewed while it thinks */
const TYPING_TIMEOUT = 30000;

/** What to tell the user when the agent couldn't answer */
function describeError(error: AgentErrorCode): string {
    switch (error) {
        case "not_connected":
            return _t("agent_assistant|error_not_connected");
        case "rate_limited":
            return _t("agent_assistant|error_rate_limited");
        default:
            return _t("agent_assistant|error_unknown", { error });
    }
}

/**
 * The chat with the agent of Element Pilot: a private room of the user, where each message of the user is a
 * request to the agent. The agent answers there, and can look at and change the to-do list, start work on tasks,
 * plan them and tell the state of the pipelines.
 *
 * The room is created when it is first needed, and remembered in the account data, so that every device of the
 * user finds the same room. Only this device answers, as the agent runs on it. The agent's messages are sent as the
 * user and marked as written by an agent, like its other messages.
 */
export class AgentAssistantRoom {
    private static instance?: AgentAssistantRoom;

    private client?: MatrixClient;
    private agent?: AgentApi;
    private store?: AgentTaskStore;
    /** The room being created, so that it is created only once */
    private creating?: Promise<string | undefined>;
    /** The messages that were answered or are waiting for it */
    private readonly handled = new Set<string>();
    /** The answers, one after another */
    private queue: Promise<void> = Promise.resolve();

    public static sharedInstance(): AgentAssistantRoom {
        AgentAssistantRoom.instance ??= new AgentAssistantRoom();
        return AgentAssistantRoom.instance;
    }

    /**
     * Start answering the user in the chat with the agent.
     * @param client - The client of the user
     * @param agent - The agent of the platform; without one, there is no chat
     * @param store - The to-do list; the shared one by default
     */
    public start(
        client: MatrixClient,
        agent: AgentApi | undefined,
        store: AgentTaskStore = AgentTaskStore.instance,
    ): void {
        this.stop();
        if (!agent) return;
        this.client = client;
        this.agent = agent;
        this.store = store;
        client.on(RoomEvent.Timeline, this.onTimeline);
    }

    public stop(): void {
        this.client?.off(RoomEvent.Timeline, this.onTimeline);
        this.client = undefined;
        this.agent = undefined;
        this.store = undefined;
        this.creating = undefined;
        this.handled.clear();
        this.queue = Promise.resolve();
    }

    /** Whether there is a chat with the agent: only on a platform with an agent */
    public get isAvailable(): boolean {
        return Boolean(this.agent);
    }

    /** The ID of the chat with the agent, if it exists and the user is in it */
    public get roomId(): string | undefined {
        const client = this.client;
        const roomId = client?.getAccountData(ASSISTANT_ROOM_ACCOUNT_DATA)?.getContent()?.room_id;
        if (typeof roomId !== "string") return undefined;
        return client?.getRoom(roomId)?.getMyMembership() === KnownMembership.Join ? roomId : undefined;
    }

    /**
     * Get the chat with the agent, and create it if there is none yet.
     * @returns its ID, or undefined if it couldn't be created
     */
    public async ensureRoom(): Promise<string | undefined> {
        const existing = this.roomId;
        if (existing) return existing;
        const client = this.client;
        if (!client) return undefined;
        this.creating ??= this.createRoom(client).finally(() => {
            this.creating = undefined;
        });
        return this.creating;
    }

    /**
     * Show the chat with the agent, after creating it if needed.
     * @returns whether it could be shown
     */
    public async openRoom(): Promise<boolean> {
        const roomId = await this.ensureRoom();
        if (!roomId) return false;
        defaultDispatcher.dispatch<ViewRoomPayload>({
            action: Action.ViewRoom,
            room_id: roomId,
            metricsTrigger: undefined,
        });
        return true;
    }

    /**
     * Send a message of the agent to its chat, after creating it if needed.
     * @param text - The message, in Markdown
     * @returns whether it was sent
     */
    public async post(text: string): Promise<boolean> {
        const roomId = await this.ensureRoom();
        if (!roomId) return false;
        return this.send(roomId, text);
    }

    private async createRoom(client: MatrixClient): Promise<string | undefined> {
        try {
            const { room_id: roomId } = await client.createRoom({
                name: _t("agent_assistant|room_name"),
                topic: _t("agent_assistant|room_topic"),
                preset: Preset.PrivateChat,
                visibility: Visibility.Private,
                initial_state: [
                    { type: EventType.RoomEncryption, state_key: "", content: { algorithm: "m.megolm.v1.aes-sha2" } },
                ],
            });
            await client.setAccountData(ASSISTANT_ROOM_ACCOUNT_DATA, { room_id: roomId });
            await this.waitForRoom(client, roomId);
            await this.send(roomId, _t("agent_assistant|welcome"));
            return roomId;
        } catch (e) {
            logger.warn("Could not create the chat with the agent", e);
            return undefined;
        }
    }

    /** Wait until the client knows the new room, so that messages can be sent to it */
    private async waitForRoom(client: MatrixClient, roomId: string): Promise<void> {
        if (client.getRoom(roomId)) return;
        await new Promise<void>((resolve) => {
            const onRoom = (room: Room): void => {
                if (room.roomId !== roomId) return;
                client.off(ClientEvent.Room, onRoom);
                resolve();
            };
            client.on(ClientEvent.Room, onRoom);
        });
    }

    private async send(roomId: string, text: string): Promise<boolean> {
        const client = this.client;
        if (!client) return false;
        const html = htmlSerializeFromMdIfNeeded(text);
        const content = {
            msgtype: MsgType.Text,
            body: text,
            ...(html !== undefined && { format: "org.matrix.custom.html", formatted_body: html }),
            [AGENT_MESSAGE_KEY]: true,
        } as RoomMessageEventContent;
        try {
            await client.sendMessage(roomId, content);
            return true;
        } catch (e) {
            logger.warn(`Could not send the message of the agent to ${roomId}`, e);
            return false;
        }
    }

    private readonly onTimeline = (
        event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
        removed: boolean,
        data: IRoomTimelineData,
    ): void => {
        if (!room || toStartOfTimeline || removed || !data.liveEvent || room.roomId !== this.roomId) return;
        const eventId = event.getId();
        if (!eventId || this.handled.has(eventId)) return;
        this.handled.add(eventId);
        const client = this.client;
        this.queue = this.queue.then(() => (this.client === client ? this.answer(event, room) : undefined));
    };

    /** Let the agent answer a message of the user */
    private async answer(event: MatrixEvent, room: Room): Promise<void> {
        const { client, agent, store } = this;
        if (!client || !agent) return;
        await client.decryptEventIfNeeded(event);
        if (this.client !== client || !this.isMessageOfUser(client, event)) return;

        const turns = this.readTurns(client, room, event);
        const typing = setInterval(() => void client.sendTyping(room.roomId, true, TYPING_TIMEOUT).catch(() => {}), 20000);
        void client.sendTyping(room.roomId, true, TYPING_TIMEOUT).catch(() => {});
        try {
            const result = await agent
                .assistantChat({ userId: client.getSafeUserId(), ownName: this.ownName(client, room), turns })
                .catch((e) => {
                    logger.warn("The agent couldn't answer in its chat", e);
                    return { ok: false as const, error: "unavailable" as const, message: undefined };
                });
            if (this.client !== client) return;
            if (result.ok) {
                await this.send(room.roomId, result.data.text);
                if (result.data.tasksChanged) await store?.reload();
            } else {
                logger.warn(`The agent couldn't answer in its chat: ${result.error}`, result.message);
                await this.send(room.roomId, describeError(result.error));
            }
        } finally {
            clearInterval(typing);
            void client.sendTyping(room.roomId, false, 0).catch(() => {});
        }
    }

    /** Whether a message is a request of the user, not one of the agent */
    private isMessageOfUser(client: MatrixClient, event: MatrixEvent): boolean {
        if (event.getType() !== EventType.RoomMessage || event.isRedacted()) return false;
        if (event.isRelation(RelationType.Replace) || event.getSender() !== client.getSafeUserId()) return false;
        const content = event.getContent();
        return !content[AGENT_MESSAGE_KEY] && content.msgtype === MsgType.Text && typeof content.body === "string";
    }

    /** The latest messages of the chat, up to the one to answer */
    private readTurns(client: MatrixClient, room: Room, latest: MatrixEvent): AgentTurn[] {
        const events = room.getLiveTimeline().getEvents();
        const end = events.indexOf(latest);
        const turns: AgentTurn[] = [];
        for (const event of end === -1 ? [...events, latest] : events.slice(0, end + 1)) {
            if (event.getType() !== EventType.RoomMessage || event.isRedacted()) continue;
            if (event.isRelation(RelationType.Replace) || event.getSender() !== client.getSafeUserId()) continue;
            const content = event.getContent();
            if (typeof content.body !== "string" || !content.body.trim()) continue;
            turns.push({ role: content[AGENT_MESSAGE_KEY] ? "assistant" : "user", text: content.body });
        }
        return turns.slice(-HISTORY_LENGTH);
    }

    private ownName(client: MatrixClient, room: Room): string {
        return room.getMember(client.getSafeUserId())?.name ?? client.getSafeUserId();
    }
}
