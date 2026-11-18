/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "shared-types";

import {
    buildIcs,
    defaultTimeSlot,
    foldIcsLine,
    formatLocalTime,
    parseLocalTime,
    parseTimeSlot,
    scheduleAgentTask,
    suggestAgentTimeSlot,
} from "./agent-calendar.js";

const { storeData, anthropic, paths, shell } = vi.hoisted(() => ({
    storeData: {} as Record<string, unknown>,
    anthropic: { messagesCreate: vi.fn() },
    paths: { temp: "" },
    shell: { openPath: vi.fn(async () => "") },
}));

vi.mock("electron", () => ({
    app: { getPath: vi.fn((name: string) => (name === "temp" ? paths.temp : "/roaming/Element")) },
    safeStorage: {
        isEncryptionAvailable: () => true,
        decryptString: (buffer: Buffer) => buffer.toString().replace(/^encrypted:/, ""),
    },
    dialog: {},
    shell,
}));
vi.mock("electron-store", () => ({
    default: vi.fn(function (this: Record<string, unknown>) {
        this.get = (key: string) => storeData[key];
        this.set = (key: string, value: unknown) => {
            storeData[key] = structuredClone(value);
        };
    }),
}));
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@anthropic-ai/sdk")>();
    const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
        this.beta = { messages: { create: anthropic.messagesCreate } };
    });
    return { ...actual, default: MockAnthropic };
});

const USER = "@alice:example.org";

/** Wednesday, 11 November 2026, 10:07 local time */
const NOW = new Date(2026, 10, 11, 10, 7).getTime();

function task(changes: Partial<AgentTask> = {}): AgentTask {
    return { id: "task-1234567890", title: "Fix the login", details: "", done: false, createdAt: 1, ...changes };
}

describe("buildIcs", () => {
    it("writes an event with a reminder, in UTC and with escaped text", () => {
        const start = Date.UTC(2026, 10, 12, 8, 30);
        const ics = buildIcs({
            uid: "task-1@element-pilot",
            title: "Fix the login; quickly, please",
            description: "Line one\nLine two",
            start,
            durationMinutes: 90,
            now: Date.UTC(2026, 10, 11, 9, 0),
        });

        expect(ics).toContain("DTSTART:20261112T083000Z\r\n");
        expect(ics).toContain("DTEND:20261112T100000Z\r\n");
        expect(ics).toContain("SUMMARY:Fix the login\\; quickly\\, please\r\n");
        expect(ics).toContain("DESCRIPTION:Line one\\nLine two\r\n");
        expect(ics).toContain("TRIGGER:-PT10M");
        expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    });

    it("folds long lines at 75 bytes without splitting characters", () => {
        const folded = foldIcsLine(`SUMMARY:${"ä".repeat(60)}`);

        const lines = folded.split("\r\n");
        expect(lines.length).toBeGreaterThan(1);
        expect(lines.every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
        expect(lines.slice(1).every((line) => line.startsWith(" "))).toBe(true);
        expect(lines.map((line, i) => (i === 0 ? line : line.slice(1))).join("")).toBe(`SUMMARY:${"ä".repeat(60)}`);
    });
});

describe("time slots", () => {
    it("reads and writes local times", () => {
        expect(formatLocalTime(NOW)).toBe("2026-11-11T10:07");
        expect(parseLocalTime("2026-11-11T10:07")).toBe(NOW);
        expect(parseLocalTime("2026-02-30T10:00")).toBeUndefined();
        expect(parseLocalTime("tomorrow")).toBeUndefined();
    });

    it("reads the slot the agent suggested, rounding the duration", () => {
        const answer = 'Here: {"start": "2026-11-11T13:00", "durationMinutes": 50, "reason": "After lunch."}';

        expect(parseTimeSlot(answer, NOW)).toEqual({
            start: new Date(2026, 10, 11, 13, 0).getTime(),
            durationMinutes: 45,
            reason: "After lunch.",
        });
    });

    it("rejects slots in the past or without a time", () => {
        expect(parseTimeSlot('{"start": "2026-11-10T13:00", "durationMinutes": 60}', NOW)).toBeUndefined();
        expect(parseTimeSlot('{"durationMinutes": 60}', NOW)).toBeUndefined();
        expect(parseTimeSlot("no idea", NOW)).toBeUndefined();
    });

    it("defaults to an hour at the next quarter in working hours", () => {
        expect(defaultTimeSlot(NOW)).toEqual({ start: new Date(2026, 10, 11, 10, 30).getTime(), durationMinutes: 60 });
        // Friday evening moves to Monday morning
        expect(defaultTimeSlot(new Date(2026, 10, 13, 16, 30).getTime()).start).toBe(
            new Date(2026, 10, 16, 8, 0).getTime(),
        );
    });
});

describe("suggestAgentTimeSlot", () => {
    beforeEach(() => {
        for (const key of Object.keys(storeData)) delete storeData[key];
        anthropic.messagesCreate.mockReset();
    });

    it("suggests the default slot without a provider", async () => {
        storeData.tasks = { [USER]: [task()] };

        const result = await suggestAgentTimeSlot(USER, "task-1234567890", NOW);

        expect(result).toEqual({ ok: true, data: defaultTimeSlot(NOW) });
        expect(anthropic.messagesCreate).not.toHaveBeenCalled();
    });

    it("lets the agent plan around what is already planned", async () => {
        const planned = task({
            id: "task-2",
            title: "Review the release",
            schedule: { start: new Date(2026, 10, 11, 11, 0).getTime(), durationMinutes: 60 },
        });
        storeData.tasks = { [USER]: [task(), planned] };
        storeData.secrets = { claude: Buffer.from("encrypted:secret").toString("base64") };
        anthropic.messagesCreate.mockResolvedValue({
            stop_reason: "end_turn",
            content: [{ type: "text", text: '{"start": "2026-11-11T12:00", "durationMinutes": 120}' }],
        });

        const result = await suggestAgentTimeSlot(USER, "task-1234567890", NOW);

        expect(result).toEqual({
            ok: true,
            data: { start: new Date(2026, 10, 11, 12, 0).getTime(), durationMinutes: 120 },
        });
        const request = anthropic.messagesCreate.mock.calls[0][0];
        expect(request.system).toContain("Wednesday, 2026-11-11T10:07");
        expect(request.messages[0].content).toContain("2026-11-11T11:00 for 60 minutes: Review the release");
    });

    it("fails for an unknown task", async () => {
        storeData.tasks = { [USER]: [] };

        expect(await suggestAgentTimeSlot(USER, "missing", NOW)).toEqual({ ok: false, error: "not_found" });
    });
});

describe("scheduleAgentTask", () => {
    beforeEach(async () => {
        for (const key of Object.keys(storeData)) delete storeData[key];
        paths.temp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-calendar-"));
        shell.openPath.mockClear();
    });

    afterEach(async () => {
        await fs.rm(paths.temp, { recursive: true, force: true });
    });

    it("opens a calendar file and keeps the time on the task", async () => {
        storeData.tasks = { [USER]: [task({ details: "The button does nothing" })] };
        const start = new Date(2026, 10, 12, 9, 0).getTime();

        const result = await scheduleAgentTask(USER, "task-1234567890", start, 60);

        expect(result).toMatchObject({ ok: true, data: { schedule: { start, durationMinutes: 60 } } });
        const file = shell.openPath.mock.calls[0][0] as string;
        expect(path.basename(file)).toBe("fix-the-login-task-123.ics");
        const ics = await fs.readFile(file, "utf8");
        expect(ics).toContain("SUMMARY:Fix the login");
        expect(ics).toContain("DESCRIPTION:The button does nothing");
    });

    it("rejects durations out of range", async () => {
        storeData.tasks = { [USER]: [task()] };

        expect(await scheduleAgentTask(USER, "task-1234567890", NOW, 5)).toEqual({
            ok: false,
            error: "invalid_request",
        });
        expect(shell.openPath).not.toHaveBeenCalled();
    });
});
