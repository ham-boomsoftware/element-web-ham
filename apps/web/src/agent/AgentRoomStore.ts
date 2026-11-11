/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";
import { logger } from "matrix-js-sdk/src/logger";
import type { AgentRoomRule } from "shared-types";

import type { AgentApi } from "./AgentApi";

export enum AgentRoomStoreEvent {
    /** The room rules changed, or the store started or stopped */
    Update = "update",
}

type EventHandlerMap = {
    [AgentRoomStoreEvent.Update]: () => void;
};

/**
 * The rules the user set for what the agent does in a room (see {@link AgentRoomRule}).
 *
 * The rules are kept by the platform's agent on this computer only, never on the homeserver. This store holds a
 * copy of them so that the room list, {@link AgentReplyListener}, {@link AgentTaskListener} and the reply
 * suggestions can read them synchronously.
 */
export class AgentRoomStore extends TypedEventEmitter<AgentRoomStoreEvent, EventHandlerMap> {
    private static internalInstance?: AgentRoomStore;

    private agent?: AgentApi;
    private userId?: string;
    private rules = new Map<string, AgentRoomRule>();

    public static get instance(): AgentRoomStore {
        AgentRoomStore.internalInstance ??= new AgentRoomStore();
        return AgentRoomStore.internalInstance;
    }

    /** Whether rules can be set: only on a platform with an agent */
    public get isAvailable(): boolean {
        return Boolean(this.agent);
    }

    /**
     * Read the room rules of a user.
     * @param agent - The agent of the platform; without one, no rule can be set
     * @param userId - The Matrix user whose rules to read
     */
    public async start(agent: AgentApi | undefined, userId: string): Promise<void> {
        this.agent = agent;
        this.userId = userId;
        this.rules = new Map();
        this.emit(AgentRoomStoreEvent.Update);
        if (!agent) return;

        const result = await agent.getRoomRules(userId);
        // Another user may have logged in meanwhile
        if (this.agent !== agent || this.userId !== userId) return;
        if (result.ok) {
            this.rules = new Map(Object.entries(result.data));
            this.emit(AgentRoomStoreEvent.Update);
        } else {
            logger.warn(`Could not read the room rules of the agent: ${result.error}`, result.message);
        }
    }

    public stop(): void {
        this.agent = undefined;
        this.userId = undefined;
        this.rules = new Map();
        this.emit(AgentRoomStoreEvent.Update);
    }

    /** The rule of a room, or undefined if the room follows the settings */
    public getRule(roomId: string): AgentRoomRule | undefined {
        return this.rules.get(roomId);
    }

    /** Whether the agent replies in a room by itself */
    public isAgentRoom(roomId: string): boolean {
        return this.getRule(roomId) === "auto_reply";
    }

    /** Whether the agent leaves a room alone */
    public isIgnored(roomId: string): boolean {
        return this.getRule(roomId) === "ignore";
    }

    /**
     * Set the rule of a room, or remove it with undefined. The change shows straight away, and is undone if the
     * platform can't save it.
     */
    public async setRule(roomId: string, rule: AgentRoomRule | undefined): Promise<void> {
        const { agent, userId } = this;
        const previous = this.getRule(roomId);
        if (!agent || !userId || previous === rule) return;

        this.updateRule(roomId, rule);
        const result = await agent.setRoomRule(userId, roomId, rule ?? null);
        if (!result.ok) {
            logger.warn(`Could not change the agent rule of ${roomId}: ${result.error}`, result.message);
            if (this.agent === agent && this.getRule(roomId) === rule) this.updateRule(roomId, previous);
        }
    }

    private updateRule(roomId: string, rule: AgentRoomRule | undefined): void {
        if (rule) this.rules.set(roomId, rule);
        else this.rules.delete(roomId);
        this.emit(AgentRoomStoreEvent.Update);
    }
}
