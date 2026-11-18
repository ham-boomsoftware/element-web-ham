/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { describe, expect, it, vi } from "vitest";
import type { AgentRunStep } from "shared-types";

import { buildToolArgs, isLoginError, readStream, toStep } from "./agent-claude-code.js";

vi.mock("./agent.js", () => ({
    failure: (error: string, message?: string) => ({ ok: false, error, message }),
    getAgentDataPath: vi.fn(() => "/agent"),
    getAgentStore: vi.fn(),
}));

function args(list: string[]): { allowed: string[]; denied: string[] } {
    return {
        allowed: list[list.indexOf("--allowedTools") + 1].split(","),
        denied: list[list.indexOf("--disallowedTools") + 1].split(","),
    };
}

describe("buildToolArgs", () => {
    it("only lets Claude Code read the project when it looks into a task", () => {
        const { allowed, denied } = args(buildToolArgs("investigate", ["pnpm test"]));

        expect(allowed).toEqual(["Read", "Grep", "Glob", "LS"]);
        expect(denied).toEqual(expect.arrayContaining(["Edit", "Write", "Bash", "WebFetch"]));
    });

    it("lets it change files, but run no commands, to do a task", () => {
        const { allowed, denied } = args(buildToolArgs("implement", ["pnpm test"]));

        expect(allowed).toEqual(expect.arrayContaining(["Edit", "Write"]));
        expect(allowed.some((tool) => tool.startsWith("Bash"))).toBe(false);
        expect(denied).toContain("Bash");
    });

    it("lets the autopilot run exactly the allowed commands", () => {
        const { allowed, denied } = args(buildToolArgs("autopilot", ["pnpm test", "pnpm lint"]));

        expect(allowed).toEqual(expect.arrayContaining(["Bash(pnpm test)", "Bash(pnpm lint)"]));
        expect(denied).not.toContain("Bash");
    });
});

describe("readStream", () => {
    it("shows the tool uses as steps and returns the final answer", () => {
        const steps: AgentRunStep[] = [];
        const output = [
            JSON.stringify({ type: "system", subtype: "init" }),
            JSON.stringify({
                type: "assistant",
                message: {
                    content: [
                        { type: "text", text: "Let me look" },
                        { type: "tool_use", name: "Grep", input: { pattern: "login" } },
                        { type: "tool_use", name: "Read", input: { file_path: "src/login.ts" } },
                        { type: "tool_use", name: "TodoWrite", input: {} },
                    ],
                },
            }),
            "not json",
            JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "The login fails." }),
        ].join("\n");

        const result = readStream(
            output,
            (step) => steps.push(step),
            () => 7,
        );

        expect(result).toEqual({ answer: "The login fails." });
        expect(steps).toEqual([
            { kind: "search", text: "login", at: 7 },
            { kind: "read", text: "src/login.ts", at: 7 },
        ]);
    });

    it("returns the error of a failed run", () => {
        const output = JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" });

        expect(
            readStream(
                output,
                () => {},
                () => 0,
            ),
        ).toEqual({ error: "error_max_turns" });
    });
});

describe("toStep", () => {
    it("shows the command of Bash", () => {
        expect(toStep("Bash", { command: "pnpm test" }, 1)).toEqual({ kind: "command", text: "pnpm test", at: 1 });
    });
});

describe("isLoginError", () => {
    it("tells a missing login apart from other errors", () => {
        expect(isLoginError("Invalid API key · Please run /login")).toBe(true);
        expect(isLoginError("Not logged in")).toBe(true);
        expect(isLoginError("Rate limit reached")).toBe(false);
    });
});
