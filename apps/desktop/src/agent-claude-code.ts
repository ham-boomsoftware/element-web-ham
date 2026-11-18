/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Lets Claude Code, the coding CLI, work on a task in the background, with the Claude account it is logged in with,
// such as the user's subscription. No API key is needed. The CLI can use a configuration folder of its own, so that
// the agent works with another Claude account than the user's own sessions.
//
// The task comes from a chat, often from someone else, so its text never goes on a command line: the prompt goes in
// through stdin, and the system prompt through a file. Which tools the CLI may use depends on what the agent does:
// only reading to look into a task, also editing files to do it, and only the allowed commands for the autopilot.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentResult, AgentRunStep, AgentRunStepKind, AgentTaskRunMode } from "shared-types";

import { failure, getAgentDataPath, getAgentStore } from "./agent.js";

/** The longest the CLI may work on a task */
const RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** The tools of Claude Code that only read the project */
const READ_TOOLS = ["Read", "Grep", "Glob", "LS"];

/** The tools of Claude Code that change files */
const EDIT_TOOLS = ["Edit", "MultiEdit", "Write"];

/** The tools the CLI never gets: it doesn't go on the web, and runs no commands but the allowed ones */
const DENIED_TOOLS = ["WebFetch", "WebSearch", "NotebookEdit", "Task"];

/** What a run of Claude Code needs to know */
export interface ClaudeCodeRun {
    /** The folder the CLI works in */
    root: string;
    mode: AgentTaskRunMode;
    system: string;
    prompt: string;
    /** The commands the autopilot may run, each exactly */
    commands: string[];
    onStep(step: AgentRunStep): void;
}

/** The settings of Claude Code for the agent */
export interface ClaudeCodeSettings {
    /** Whether the agent works on tasks with Claude Code instead of the API of the provider */
    enabled: boolean;
    /** The configuration folder of the CLI, for another Claude account than the user's own; undefined for theirs */
    configDir?: string;
}

/** The settings of Claude Code; it is used unless the user turned it off */
export function getClaudeCodeSettings(): ClaudeCodeSettings {
    const stored = getAgentStore().get("claudeCode");
    return { enabled: stored?.enabled ?? true, configDir: stored?.configDir || undefined };
}

/** Change the settings of Claude Code */
export function setClaudeCodeSettings(changes: Partial<ClaudeCodeSettings>): ClaudeCodeSettings {
    const settings = { ...getClaudeCodeSettings(), ...changes };
    getAgentStore().set("claudeCode", settings);
    return getClaudeCodeSettings();
}

/** The tools of the CLI, as its options, for what the agent does */
export function buildToolArgs(mode: AgentTaskRunMode, commands: string[]): string[] {
    const allowed = [...READ_TOOLS];
    if (mode !== "investigate") allowed.push(...EDIT_TOOLS);
    if (mode === "autopilot") allowed.push(...commands.map((command) => `Bash(${command})`));
    const denied = [...DENIED_TOOLS];
    if (mode === "investigate") denied.push(...EDIT_TOOLS);
    if (mode !== "autopilot" || commands.length === 0) denied.push("Bash");
    return ["--allowedTools", allowed.join(","), "--disallowedTools", denied.join(",")];
}

/** What the system prompt says about the tools, which are the CLI's own rather than the agent's */
export const CLAUDE_CODE_TOOL_NOTE =
    "You work in Claude Code. Your tools are its own: Read, Grep, Glob and LS to look into the project, and, if you " +
    "may change files, Edit, MultiEdit and Write instead of workspace_write and workspace_edit; and if you may run " +
    "commands, Bash for exactly the allowed ones instead of workspace_run. You can't ask anyone questions; decide " +
    "by yourself, and say in your report what you assumed.";

const STEP_KINDS: Record<string, AgentRunStepKind> = {
    Read: "read",
    Grep: "search",
    Glob: "search",
    LS: "list",
    Edit: "edit",
    MultiEdit: "edit",
    Write: "write",
    Bash: "command",
};

/** A step of the work, from a tool the CLI used, or undefined for a tool that isn't shown */
export function toStep(name: string, input: Record<string, unknown> | undefined, at: number): AgentRunStep | undefined {
    const kind = STEP_KINDS[name];
    if (!kind) return undefined;
    const text = [input?.file_path, input?.path, input?.pattern, input?.command].find(
        (value): value is string => typeof value === "string" && value.length > 0,
    );
    return { kind, text: (text ?? name).slice(0, 300), at };
}

/** One line of the stream of the CLI, as `--output-format stream-json` writes it */
interface StreamEvent {
    type?: string;
    subtype?: string;
    is_error?: boolean;
    result?: string;
    message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] };
}

/**
 * Read the stream of the CLI: show its tool uses as steps, and get its final answer.
 * @returns the answer, or why it failed
 */
export function readStream(
    output: string,
    onStep: (step: AgentRunStep) => void,
    now: () => number,
): { answer?: string; error?: string } {
    let result: { answer?: string; error?: string } = {};
    for (const line of output.split("\n")) {
        if (!line.trim()) continue;
        let event: StreamEvent;
        try {
            event = JSON.parse(line) as StreamEvent;
        } catch {
            continue;
        }
        if (event.type === "assistant") {
            for (const block of event.message?.content ?? []) {
                if (block.type !== "tool_use" || !block.name) continue;
                const step = toStep(block.name, block.input, now());
                if (step) onStep(step);
            }
        } else if (event.type === "result") {
            result =
                event.is_error || event.subtype !== "success"
                    ? { error: event.result || event.subtype || "error" }
                    : { answer: event.result ?? "" };
        }
    }
    return result;
}

/** Whether the CLI failed because it isn't logged in */
export function isLoginError(text: string): boolean {
    return /\/login|not logged in|log in|authenticat|invalid api key/i.test(text);
}

/**
 * Let Claude Code work on a task in its folder, and wait for its report.
 */
export async function runWithClaudeCode(run: ClaudeCodeRun): Promise<AgentResult<string>> {
    const dir = path.join(getAgentDataPath(), "claude-code");
    await fs.mkdir(dir, { recursive: true });
    const systemFile = path.join(dir, `system-${randomUUID()}.md`);
    await fs.writeFile(systemFile, `${run.system}\n\n${CLAUDE_CODE_TOOL_NOTE}\n`, "utf8");
    const { configDir } = getClaudeCodeSettings();
    const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--append-system-prompt-file",
        systemFile,
        ...buildToolArgs(run.mode, run.commands),
    ];

    let pending = "";
    const output: string[] = [];
    try {
        const exit = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
            const child = spawn("claude", args, {
                cwd: run.root,
                env: { ...process.env, ...(configDir && { CLAUDE_CONFIG_DIR: configDir }) },
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });
            const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (chunk: string) => {
                // Steps are shown as they come, line by line
                pending += chunk;
                const lines = pending.split("\n");
                pending = lines.pop() ?? "";
                const complete = lines.join("\n");
                output.push(complete);
                readStream(
                    complete,
                    (step) => run.onStep(step),
                    () => Date.now(),
                );
            });
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk: string) => (stderr += chunk));
            child.once("error", (e) => {
                clearTimeout(timer);
                reject(e);
            });
            child.once("close", (code) => {
                clearTimeout(timer);
                resolve({ code, stderr });
            });
            child.stdin.end(run.prompt, "utf8");
        });
        output.push(pending);
        const { answer, error } = readStream(
            output.join("\n"),
            () => {},
            () => Date.now(),
        );
        if (answer !== undefined) return { ok: true, data: answer };
        const message = (error ?? exit.stderr).trim() || `Claude Code ended with exit code ${exit.code}`;
        console.warn("Claude Code failed on a task", message);
        return failure(isLoginError(message) ? "not_connected" : "unavailable", message.slice(0, 1000));
    } catch (e) {
        console.error("Failed to start Claude Code", e);
        const missing = (e as NodeJS.ErrnoException)?.code === "ENOENT";
        return failure("unavailable", missing ? "Claude Code (claude) is not installed" : String(e));
    } finally {
        await fs.rm(systemFile, { force: true });
    }
}
