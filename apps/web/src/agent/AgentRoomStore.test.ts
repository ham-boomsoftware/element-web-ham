/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { vi, describe, it, expect, beforeEach, afterEach, type Mocked } from "vitest";

import { AgentRoomStore, AgentRoomStoreEvent } from "./AgentRoomStore";
import type { AgentApi } from "./AgentApi";

const ALICE = "@alice:example.org";

describe("AgentRoomStore", () => {
    let agent: Mocked<AgentApi>;
    let store: AgentRoomStore;

    beforeEach(() => {
        agent = {
            getStatus: vi.fn(),
            setSettings: vi.fn(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            listModels: vi.fn(),
            getRoomRules: vi.fn().mockResolvedValue({ ok: true, data: { "!a:example.org": "auto_reply" } }),
            setRoomRule: vi.fn(async (_userId, roomId, rule) => ({
                ok: true as const,
                data: rule ? { [roomId]: rule } : {},
            })),
            connectLoggedInUser: vi.fn(),
            getRoomInstructions: vi
                .fn()
                .mockResolvedValue({ ok: true, data: { "!a:example.org": "Answer in German" } }),
            setRoomInstructions: vi.fn(async (_userId, roomId, instructions) => ({
                ok: true as const,
                data: instructions ? { [roomId]: instructions } : {},
            })),
            generateReply: vi.fn(),
            generateSuggestions: vi.fn(),
            pickWorkspace: vi.fn(),
            getTasks: vi.fn(),
            addTasks: vi.fn(),
            updateTask: vi.fn(),
            deleteTask: vi.fn(),
            detectTasks: vi.fn(),
            runTask: vi.fn(),
            pickFolder: vi.fn(),
            openTaskInCli: vi.fn(),
        };
        store = new AgentRoomStore();
    });

    afterEach(() => {
        store.stop();
    });

    it("reads the room rules of the user from the platform", async () => {
        const onUpdate = vi.fn();
        store.on(AgentRoomStoreEvent.Update, onUpdate);

        await store.start(agent, ALICE);

        expect(agent.getRoomRules).toHaveBeenCalledWith(ALICE);
        expect(store.isAvailable).toBe(true);
        expect(store.getRule("!a:example.org")).toBe("auto_reply");
        expect(store.isAgentRoom("!a:example.org")).toBe(true);
        expect(store.getRule("!b:example.org")).toBeUndefined();
        expect(store.isAgentRoom("!b:example.org")).toBe(false);
        expect(onUpdate).toHaveBeenCalled();
    });

    it("has no rules on a platform without an agent", async () => {
        await store.start(undefined, ALICE);

        expect(store.isAvailable).toBe(false);
        expect(store.getRule("!a:example.org")).toBeUndefined();
    });

    it("sets and removes the rule of a room, saving it on the platform", async () => {
        await store.start(agent, ALICE);

        const setting = store.setRule("!b:example.org", "ignore");
        // The rule shows before the platform has saved it
        expect(store.isIgnored("!b:example.org")).toBe(true);
        await setting;
        expect(agent.setRoomRule).toHaveBeenCalledWith(ALICE, "!b:example.org", "ignore");

        await store.setRule("!b:example.org", "tasks_only");
        expect(store.getRule("!b:example.org")).toBe("tasks_only");
        expect(store.isIgnored("!b:example.org")).toBe(false);

        await store.setRule("!a:example.org", undefined);
        expect(agent.setRoomRule).toHaveBeenCalledWith(ALICE, "!a:example.org", null);
        expect(store.getRule("!a:example.org")).toBeUndefined();
    });

    it("restores the previous rule when the platform can't save the new one", async () => {
        await store.start(agent, ALICE);
        agent.setRoomRule.mockResolvedValue({ ok: false, error: "unavailable" });

        await store.setRule("!a:example.org", "ignore");

        expect(store.getRule("!a:example.org")).toBe("auto_reply");
    });

    it("doesn't save a rule that doesn't change anything", async () => {
        await store.start(agent, ALICE);

        await store.setRule("!a:example.org", "auto_reply");
        await store.setRule("!b:example.org", undefined);

        expect(agent.setRoomRule).not.toHaveBeenCalled();
    });

    it("reads the room instructions of the user from the platform", async () => {
        await store.start(agent, ALICE);

        expect(agent.getRoomInstructions).toHaveBeenCalledWith(ALICE);
        expect(store.getInstructions("!a:example.org")).toBe("Answer in German");
        expect(store.getInstructions("!b:example.org")).toBeUndefined();
    });

    it("sets the instructions of a room once the platform saved them", async () => {
        await store.start(agent, ALICE);
        const onUpdate = vi.fn();
        store.on(AgentRoomStoreEvent.Update, onUpdate);

        await expect(store.setInstructions("!b:example.org", "  Be brief  ")).resolves.toBe(true);

        expect(agent.setRoomInstructions).toHaveBeenCalledWith(ALICE, "!b:example.org", "Be brief");
        expect(store.getInstructions("!b:example.org")).toBe("Be brief");
        expect(onUpdate).toHaveBeenCalled();
    });

    it("keeps the instructions when the platform can't save new ones", async () => {
        await store.start(agent, ALICE);
        agent.setRoomInstructions.mockResolvedValue({ ok: false, error: "unavailable" });

        await expect(store.setInstructions("!a:example.org", "Be brief")).resolves.toBe(false);

        expect(store.getInstructions("!a:example.org")).toBe("Answer in German");
    });

    it("forgets the rules when stopped", async () => {
        await store.start(agent, ALICE);

        store.stop();

        expect(store.isAvailable).toBe(false);
        expect(store.getRule("!a:example.org")).toBeUndefined();
    });

    it("ignores rules read for a user that logged out meanwhile", async () => {
        let finish: (result: { ok: true; data: Record<string, "auto_reply"> }) => void = () => {};
        agent.getRoomRules.mockReturnValue(new Promise((resolve) => (finish = resolve)));
        const starting = store.start(agent, ALICE);

        store.stop();
        finish({ ok: true, data: { "!a:example.org": "auto_reply" } });
        await starting;

        expect(store.getRule("!a:example.org")).toBeUndefined();
    });
});
