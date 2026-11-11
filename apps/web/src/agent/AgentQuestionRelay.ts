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
import type { RoomMessageEventContent } from "matrix-js-sdk/src/types";

import { AgentTaskStore, AgentTaskStoreEvent } from "./AgentTaskStore";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";
import DMRoomMap from "../utils/DMRoomMap";
import { stripPlainReply } from "../utils/Reply";
import { _t } from "../languageHandler";

/** A question of the agent that was asked in a chat, and waits for its answer there */
interface AskedQuestion {
    taskId: string;
    /** When the agent asked it, which tells it apart from a later question about the same task */
    askedAt: number;
    roomId: string;
    /** The message with the question, once it was sent */
    eventId?: string;
    /** Whether an answer came from the chat; the agent may not have taken it yet */
    answered?: boolean;
}

/**
 * Asks the questions the agent has while working on a task in the chat the task came from, and gives it the
 * answers.
 *
 * A question is sent as the user, as a reply to the message that asked for the task, and marked as written by an
 * agent. A reply to the question answers it; in a direct chat, so does any next message of the other person.
 * The user can also answer in the to-do list, which goes straight to the agent through {@link AgentTaskStore}.
 */
export class AgentQuestionRelay {
    private static instance?: AgentQuestionRelay;

    private client?: MatrixClient;
    private store?: AgentTaskStore;
    /** The questions asked in a chat that wait for an answer, by task */
    private readonly asked = new Map<string, AskedQuestion>();
    /** The messages that answered a question, so that they are not read as new requests */
    private readonly answers = new Set<string>();

    public static sharedInstance(): AgentQuestionRelay {
        AgentQuestionRelay.instance ??= new AgentQuestionRelay();
        return AgentQuestionRelay.instance;
    }

    /**
     * Start asking the questions of the agent in their chats, and reading the answers.
     * @param client - The client of the user the to-do list is for
     * @param store - The to-do list; the shared one by default
     */
    public start(client: MatrixClient, store: AgentTaskStore = AgentTaskStore.instance): void {
        this.stop();
        this.client = client;
        this.store = store;
        store.on(AgentTaskStoreEvent.Update, this.onTasks);
        client.on(RoomEvent.Timeline, this.onTimeline);
        this.onTasks();
    }

    public stop(): void {
        this.store?.off(AgentTaskStoreEvent.Update, this.onTasks);
        this.client?.off(RoomEvent.Timeline, this.onTimeline);
        this.store = undefined;
        this.client = undefined;
        this.asked.clear();
        this.answers.clear();
    }

    /**
     * Whether a message answers a question of the agent, or can, so that it is not read as a new request: a
     * reply to a question, or a message in a direct chat where a question waits for its answer.
     */
    public isAnswer(event: MatrixEvent): boolean {
        const eventId = event.getId();
        if (eventId && this.answers.has(eventId)) return true;
        const roomId = event.getRoomId();
        return [...this.asked.values()].some(
            (question) =>
                !question.answered &&
                question.roomId === roomId &&
                ((question.eventId && event.replyEventId === question.eventId) || this.isDirect(roomId)),
        );
    }

    /** Ask the new questions of the agent, and forget those that were answered */
    private readonly onTasks = (): void => {
        const store = this.store;
        if (!store) return;
        const waiting = new Set<string>();
        for (const task of store.tasks) {
            const { run, source } = task;
            const question = run?.state === "running" ? run.question : undefined;
            if (!question || question.answer !== undefined || !source) continue;
            waiting.add(task.id);
            if (this.asked.get(task.id)?.askedAt === question.askedAt) continue;

            const asked: AskedQuestion = { taskId: task.id, askedAt: question.askedAt, roomId: source.roomId };
            this.asked.set(task.id, asked);
            void this.send(asked, task.title, question.text, source.eventId);
        }
        for (const taskId of this.asked.keys()) {
            if (!waiting.has(taskId)) this.asked.delete(taskId);
        }
    };

    /** Send a question to its chat, as a reply to the message that asked for the task */
    private async send(asked: AskedQuestion, title: string, question: string, replyTo?: string): Promise<void> {
        const client = this.client;
        if (!client) return;
        const content = {
            msgtype: MsgType.Text,
            body: _t("agent_todo_list|question_message", { title, question }),
            [AGENT_MESSAGE_KEY]: true,
            ...(replyTo && { "m.relates_to": { "m.in_reply_to": { event_id: replyTo } } }),
        } as RoomMessageEventContent;
        try {
            const { event_id: eventId } = await client.sendMessage(asked.roomId, content);
            asked.eventId = eventId;
        } catch (e) {
            // The user can still answer in the to-do list
            logger.warn(`Could not ask the question of the task ${asked.taskId} in ${asked.roomId}`, e);
        }
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

    /** Give the agent the answer, if the message is one */
    private async onLiveEvent(event: MatrixEvent, room: Room): Promise<void> {
        const client = this.client;
        if (!client) return;
        await client.decryptEventIfNeeded(event);
        if (this.client !== client || event.getType() !== EventType.RoomMessage) return;
        if (event.isRedacted() || event.isRelation(RelationType.Replace)) return;
        const content = event.getContent();
        if (event.getSender() === client.getSafeUserId() || content[AGENT_MESSAGE_KEY]) return;
        if (content.msgtype !== MsgType.Text || typeof content.body !== "string") return;

        // A reply to a question answers it; in a direct chat, the next message answers the latest question
        const questions = [...this.asked.values()].filter(
            (question) => !question.answered && question.roomId === room.roomId,
        );
        const question =
            questions.find((question) => question.eventId && event.replyEventId === question.eventId) ??
            (this.isDirect(room.roomId) ? questions.sort((a, b) => b.askedAt - a.askedAt)[0] : undefined);
        const answer = stripPlainReply(content.body).trim();
        if (!question || !answer) return;

        question.answered = true;
        const eventId = event.getId();
        if (eventId) this.answers.add(eventId);
        const error = await this.store?.answerQuestion(
            question.taskId,
            answer,
            event.sender?.name ?? event.getSender(),
        );
        if (error) logger.warn(`The answer in ${room.roomId} came too late for the task ${question.taskId}: ${error}`);
    }

    private isDirect(roomId: string | undefined): boolean {
        return Boolean(roomId && DMRoomMap.shared()?.getUserIdForRoomId(roomId));
    }
}
