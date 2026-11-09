/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach, afterEach, type Mocked } from "vitest";
import {
    MsgType,
    RoomEvent,
    type IRoomTimelineData,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk/src/matrix";
import { mkMessage, stubClient } from "test-utils";
import type { AgentStatus } from "shared-types";

import { AgentTaskListener, DETECTION_DELAY_MS } from "./AgentTaskListener";
import type { AgentApi } from "./AgentApi";
import { AgentTaskStore } from "./AgentTaskStore";
import { AGENT_MESSAGE_KEY } from "./AgentReplyListener";
import DMRoomMap from "../utils/DMRoomMap";

const DM_ID = "!dm:example.org";
const GROUP_ID = "!team:example.org";
const BOB = "@bob:example.org";
const LIVE = { liveEvent: true } as IRoomTimelineData;

const STATUS: AgentStatus = {
    provider: "claude",
    instructions: "",
    replySuggestions: true,
    taskDetection: true,
    autoInvestigate: false,
    codingCli: "claude",
    connected: { claude: true, copilot: false },
    recentProjects: [],
};

describe("AgentTaskListener", () => {
    let client: MatrixClient;
    let agent: Mocked<AgentApi>;
    let rooms: Record<string, Room>;
    let events: Record<string, MatrixEvent[]>;
    let listener: AgentTaskListener;
    let me: string;

    function mkRoom(roomId: string, name: string): Room {
        events[roomId] = [];
        return {
            roomId,
            name,
            getLiveTimeline: () => ({ getEvents: () => events[roomId] }),
            getMember: (userId: string) => ({ name: userId === me ? "Alice" : "Bob" }),
        } as unknown as Room;
    }

    /** A message in a room, appended to its timeline and announced as a live event */
    function receive(roomId: string, sender: string, body: string, content: Record<string, unknown> = {}): MatrixEvent {
        const event = mkMessage({ room: roomId, user: sender, msg: body, ts: Date.now(), event: true });
        Object.assign(event.getContent(), content);
        events[roomId].push(event);
        client.emit(RoomEvent.Timeline, event, rooms[roomId], false, false, LIVE);
        return event;
    }

    beforeEach(async () => {
        vi.useFakeTimers({ now: 1_000_000 });
        client = stubClient();
        me = client.getSafeUserId();
        events = {};
        rooms = { [DM_ID]: mkRoom(DM_ID, "Bob"), [GROUP_ID]: mkRoom(GROUP_ID, "Team") };
        DMRoomMap.setShared({
            getUserIdForRoomId: (roomId: string) => (roomId === DM_ID ? BOB : undefined),
        } as unknown as DMRoomMap);
        vi.mocked(client.getPushActionsForEvent).mockReturnValue(null);
        agent = {
            getStatus: vi.fn().mockResolvedValue(STATUS),
            setSettings: vi.fn(),
            connect: vi.fn(),
            disconnect: vi.fn(),
            listModels: vi.fn(),
            getRooms: vi.fn(),
            setRoom: vi.fn(),
            generateReply: vi.fn(),
            generateSuggestions: vi.fn(),
            pickWorkspace: vi.fn(),
            getTasks: vi.fn().mockResolvedValue({ ok: true, data: [] }),
            addTasks: vi.fn(async (_userId, tasks) => ({
                ok: true as const,
                data: tasks.map((task, i) => ({ ...task, id: `task-${i}`, done: false, createdAt: 1 })),
            })),
            updateTask: vi.fn(),
            deleteTask: vi.fn(),
            detectTasks: vi.fn().mockResolvedValue({
                ok: true,
                data: [{ title: "Create a ticket", details: "Bob asked for a ticket" }],
            }),
            runTask: vi.fn().mockResolvedValue({ ok: false, error: "no_workspace" }),
            pickFolder: vi.fn(),
            openTaskInCli: vi.fn(),
        };
        await AgentTaskStore.instance.start(agent, me);
        listener = new AgentTaskListener();
        listener.start(client, agent);
    });

    afterEach(() => {
        listener.stop();
        AgentTaskStore.instance.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("adds the requests in new messages of a direct chat to the list", async () => {
        events[DM_ID].push(mkMessage({ room: DM_ID, user: me, msg: "Hi Bob", ts: 1, event: true }));
        receive(DM_ID, BOB, "Can you create a ticket?");
        const last = receive(DM_ID, BOB, "For the login bug");

        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.detectTasks).toHaveBeenCalledTimes(1);
        expect(agent.detectTasks).toHaveBeenCalledWith({
            ownName: "Alice",
            chatName: "Bob",
            isDirect: true,
            messages: [
                { sender: me, own: true, text: "Hi Bob" },
                { sender: BOB, own: false, text: "Can you create a ticket?" },
                { sender: BOB, own: false, text: "For the login bug" },
            ],
            newCount: 2,
            openTasks: [],
        });
        expect(agent.addTasks).toHaveBeenCalledWith(me, [
            {
                title: "Create a ticket",
                details: "Bob asked for a ticket",
                source: { roomId: DM_ID, roomName: "Bob", sender: BOB, eventId: last.getId() },
            },
        ]);
        expect(AgentTaskStore.instance.tasks.map((task) => task.title)).toEqual(["Create a ticket"]);
        expect(agent.runTask).not.toHaveBeenCalled();
    });

    it("only reads group chat messages that mention the user", async () => {
        receive(GROUP_ID, BOB, "Someone should look at the build");
        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);
        expect(agent.detectTasks).not.toHaveBeenCalled();

        vi.mocked(client.getPushActionsForEvent).mockReturnValue({ notify: true, tweaks: { highlight: true } });
        receive(GROUP_ID, BOB, "Alice, can you look at the build?");
        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.detectTasks).toHaveBeenCalledWith(
            expect.objectContaining({ chatName: "Team", isDirect: false, newCount: 1 }),
        );
    });

    it.each([
        ["the user's own message", () => receive(DM_ID, "@userId:matrix.org", "I'll do it")],
        ["a notice", () => receive(DM_ID, BOB, "Build failed", { msgtype: MsgType.Notice })],
        ["a message written by an agent", () => receive(DM_ID, BOB, "Please check", { [AGENT_MESSAGE_KEY]: true })],
    ])("does not read %s", async (_, send) => {
        send();

        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.detectTasks).not.toHaveBeenCalled();
    });

    it("does not read messages when collecting requests is turned off", async () => {
        agent.getStatus.mockResolvedValue({ ...STATUS, taskDetection: false });
        receive(DM_ID, BOB, "Can you create a ticket?");

        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.detectTasks).not.toHaveBeenCalled();
    });

    it("tells the agent which tasks are already open", async () => {
        await AgentTaskStore.instance.addTasks([{ title: "Review the notes", details: "" }]);
        receive(DM_ID, BOB, "Can you create a ticket?");

        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.detectTasks.mock.calls[0][0].openTasks).toEqual(["Review the notes"]);
    });

    it("lets the agent look into new tasks when the user turned it on", async () => {
        agent.getStatus.mockResolvedValue({ ...STATUS, autoInvestigate: true, workspacePath: "/work" });
        receive(DM_ID, BOB, "Can you create a ticket?");

        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.runTask).toHaveBeenCalledWith(me, "task-0", "investigate");
    });

    it("adds nothing when the agent can't read the messages", async () => {
        agent.detectTasks.mockResolvedValue({ ok: false, error: "rate_limited" });
        receive(DM_ID, BOB, "Can you create a ticket?");

        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.addTasks).not.toHaveBeenCalled();
    });

    it("stops reading when stopped", async () => {
        receive(DM_ID, BOB, "Can you create a ticket?");
        listener.stop();

        await vi.advanceTimersByTimeAsync(DETECTION_DELAY_MS);

        expect(agent.detectTasks).not.toHaveBeenCalled();
    });
});
