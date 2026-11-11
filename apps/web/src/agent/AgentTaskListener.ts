/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    EventType,
    type IRoomTimelineData,
    type MatrixClient,
    type MatrixEvent,
    MsgType,
    RelationType,
    type Room,
    RoomEvent,
} from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import type { AgentSuggestionMessage } from "shared-types";

import type { AgentApi } from "./AgentApi";
import { AgentTaskStore } from "./AgentTaskStore";
import { AgentRoomStore } from "./AgentRoomStore";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";
import DMRoomMap from "../utils/DMRoomMap";

/** How long to wait after a new message, so that several messages in a row are read together */
export const DETECTION_DELAY_MS = 5000;

/** How many of the latest messages the agent sees, for context */
export const HISTORY_LENGTH = 20;

/** The kinds of message that can ask for something */
const READ_MSGTYPES: ReadonlySet<string | undefined> = new Set<string | undefined>([MsgType.Text, MsgType.Emote]);

/**
 * Adds the requests to the user that the agent finds in new messages to the to-do list ({@link AgentTaskStore}).
 *
 * The agent reads every new message of someone else in a direct chat, and the messages of group chats that
 * mention the user. The rules of the rooms ({@link AgentRoomStore}) change that: a room set to `tasks_only` is
 * read in full, also when task detection is turned off, and a room set to `ignore` is not read at all. When the
 * user turned it on in the settings, the agent also looks into each new task in the workspace by itself, without
 * changing anything.
 *
 * Only new messages are read: those sent before the client started are left alone.
 */
export class AgentTaskListener {
    private static instance?: AgentTaskListener;

    private client?: MatrixClient;
    private agent?: AgentApi;
    private startedAt = 0;
    /** Rooms with new messages to read, with the first of them and the timer that starts reading */
    private readonly pending = new Map<string, { firstEvent: MatrixEvent; timer: ReturnType<typeof setTimeout> }>();

    public static sharedInstance(): AgentTaskListener {
        AgentTaskListener.instance ??= new AgentTaskListener();
        return AgentTaskListener.instance;
    }

    /**
     * Start reading new messages for requests.
     * @param client - The client of the user the to-do list is for
     * @param agent - The agent of the platform; without one, nothing is read
     */
    public start(client: MatrixClient, agent: AgentApi | undefined): void {
        this.stop();
        if (!agent) return;
        this.client = client;
        this.agent = agent;
        this.startedAt = Date.now();
        client.on(RoomEvent.Timeline, this.onTimeline);
    }

    public stop(): void {
        this.client?.off(RoomEvent.Timeline, this.onTimeline);
        for (const { timer } of this.pending.values()) clearTimeout(timer);
        this.pending.clear();
        this.client = undefined;
        this.agent = undefined;
    }

    private readonly onTimeline = (
        event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline: boolean | undefined,
        removed: boolean,
        data: IRoomTimelineData,
    ): void => {
        if (!room || toStartOfTimeline || removed || !data.liveEvent) return;
        void this.onLiveEvent(event, room);
    };

    private async onLiveEvent(event: MatrixEvent, room: Room): Promise<void> {
        const client = this.client;
        if (!client || event.getTs() < this.startedAt) return;
        // The type and content of an encrypted message are only known once it is decrypted
        await client.decryptEventIfNeeded(event);
        if (this.client !== client || !this.isRequestCandidate(client, event, room)) return;

        // Wait for more messages in a row, and read them together
        const pending = this.pending.get(room.roomId);
        if (pending) clearTimeout(pending.timer);
        this.pending.set(room.roomId, {
            firstEvent: pending?.firstEvent ?? event,
            timer: setTimeout(() => {
                const { firstEvent } = this.pending.get(room.roomId) ?? {};
                this.pending.delete(room.roomId);
                if (firstEvent) void this.detect(room, firstEvent);
            }, DETECTION_DELAY_MS),
        });
    }

    /**
     * Whether the event is a message that can hold a request to the user: a message of someone else in a direct
     * chat, in a room set to `tasks_only`, or one that mentions the user in a group chat. Messages written by an
     * agent, and rooms set to `ignore`, are left out.
     */
    private isRequestCandidate(client: MatrixClient, event: MatrixEvent, room: Room): boolean {
        if (event.getType() !== EventType.RoomMessage || event.isRedacted() || event.isRelation(RelationType.Replace)) {
            return false;
        }
        const content = event.getContent();
        if (event.getSender() === client.getSafeUserId() || !READ_MSGTYPES.has(content.msgtype)) return false;
        if (content[AGENT_MESSAGE_KEY]) return false;
        const rule = AgentRoomStore.instance.getRule(room.roomId);
        if (rule === "ignore") return false;
        if (rule === "tasks_only" || DMRoomMap.shared()?.getUserIdForRoomId(room.roomId)) return true;
        return Boolean(client.getPushActionsForEvent(event)?.tweaks?.highlight);
    }

    /**
     * Let the agent read the new messages of a room, from the first of them, and add the requests it finds.
     */
    private async detect(room: Room, firstEvent: MatrixEvent): Promise<void> {
        const { client, agent } = this;
        if (!client || !agent) return;
        try {
            const status = await agent.getStatus();
            // A room set to tasks_only is read even when task detection is turned off for all other rooms
            const rule = AgentRoomStore.instance.getRule(room.roomId);
            const enabled = rule === "tasks_only" || (status.taskDetection && rule !== "ignore");
            if (!enabled || !status.connected[status.provider]) return;

            const { messages, newCount } = this.getMessages(client, room, firstEvent);
            if (newCount === 0) return;
            const store = AgentTaskStore.instance;
            const myUserId = client.getSafeUserId();
            const result = await agent.detectTasks({
                ownName: room.getMember(myUserId)?.name ?? myUserId,
                chatName: room.name,
                isDirect: Boolean(DMRoomMap.shared()?.getUserIdForRoomId(room.roomId)),
                messages,
                newCount,
                openTasks: store.tasks.filter((task) => !task.done).map((task) => task.title),
            });
            if (this.client !== client) return;
            if (!result.ok) {
                logger.warn(`Agent could not look for tasks in ${room.roomId}: ${result.error}`, result.message);
                return;
            }

            const lastRequest = this.getLastRequest(client, room);
            const added = await store.addTasks(
                result.data.map((task) => ({
                    ...task,
                    source: {
                        roomId: room.roomId,
                        roomName: room.name,
                        sender: lastRequest?.sender?.name ?? lastRequest?.getSender() ?? "",
                        eventId: lastRequest?.getId(),
                    },
                })),
            );
            if (status.autoInvestigate && status.workspacePath) {
                for (const task of added) void store.runTask(task.id, "investigate");
            }
        } catch (e) {
            logger.warn(`Agent could not look for tasks in ${room.roomId}`, e);
        }
    }

    /** The latest message of someone else in the room, which is most likely the one asking */
    private getLastRequest(client: MatrixClient, room: Room): MatrixEvent | undefined {
        const events = room.getLiveTimeline().getEvents();
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.getType() === EventType.RoomMessage && event.getSender() !== client.getSafeUserId()) {
                return event;
            }
        }
        return undefined;
    }

    /**
     * The latest messages of the room with text, oldest first, and how many of them are new: the first new message
     * and all after it.
     */
    private getMessages(
        client: MatrixClient,
        room: Room,
        firstEvent: MatrixEvent,
    ): { messages: AgentSuggestionMessage[]; newCount: number } {
        const myUserId = client.getSafeUserId();
        const messages: AgentSuggestionMessage[] = [];
        let firstNewIndex = -1;
        for (const event of room.getLiveTimeline().getEvents()) {
            if (event.getType() !== EventType.RoomMessage || event.isRedacted()) continue;
            if (event.isRelation(RelationType.Replace)) continue;
            const { body } = event.getContent();
            if (typeof body !== "string" || !body.trim()) continue;
            if (event === firstEvent) firstNewIndex = messages.length;
            messages.push({
                sender: event.sender?.name ?? event.getSender() ?? "",
                own: event.getSender() === myUserId,
                text: body,
            });
        }
        if (firstNewIndex === -1) return { messages: [], newCount: 0 };

        const newCount = messages.length - firstNewIndex;
        const shown = messages.slice(-Math.max(HISTORY_LENGTH, newCount));
        return { messages: shown, newCount };
    }
}
