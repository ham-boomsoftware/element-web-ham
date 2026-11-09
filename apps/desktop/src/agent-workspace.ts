/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// The tools the agent uses to work on a task in the workspace, the local folder of a project the user chose.
//
// The tools only read and write files inside the workspace, and never inside its .git folder. There is no tool to
// run commands, so the agent can't commit, push or run anything: its changes stay in the working tree for the user
// to review.

import fs from "node:fs/promises";
import path from "node:path";

/** A tool as the providers describe it: a name, what it does, and a JSON schema of its input */
export interface WorkspaceToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, { type: string; description: string }>;
        required: string[];
    };
}

/** Folders that are never searched: they are big, generated, or the repository's own data */
const SKIPPED_FOLDERS = new Set([".git", "node_modules", "dist", "build", "lib", "coverage", ".next", "target"]);

/** The longest file the tools read or search, in bytes */
const MAX_FILE_SIZE = 1024 * 1024;

/** How many lines workspace_read returns at most */
const MAX_LINES = 2000;

/** How many matches search returns at most */
const MAX_MATCHES = 100;

/** How many entries workspace_list returns at most */
const MAX_ENTRIES = 500;

const READ_TOOLS: WorkspaceToolDefinition[] = [
    {
        name: "workspace_list",
        description: "List the files and folders in a folder of the project. Folders end with a slash.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: 'Folder relative to the project root; "." for the root' },
            },
            required: ["path"],
        },
    },
    {
        name: "workspace_read",
        description: `Read a text file of the project, with line numbers. Returns at most ${MAX_LINES} lines.`,
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File relative to the project root" },
                offset: { type: "number", description: "The first line to read, starting at 1" },
            },
            required: ["path"],
        },
    },
    {
        name: "workspace_search",
        description:
            `Search the text files of the project for a regular expression, case-insensitive. Returns at most ` +
            `${MAX_MATCHES} matching lines as "file:line: text". Skips node_modules, build output and .git.`,
        inputSchema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "A JavaScript regular expression" },
                path: { type: "string", description: "Folder to search in, relative to the project root" },
            },
            required: ["pattern"],
        },
    },
];

const WRITE_TOOLS: WorkspaceToolDefinition[] = [
    {
        name: "workspace_write",
        description: "Create a file of the project, or replace all of its content. Missing folders are created.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File relative to the project root" },
                content: { type: "string", description: "The whole new content of the file" },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "workspace_edit",
        description:
            "Replace one piece of text in a file of the project. old_text must occur exactly once in the file; " +
            "include enough surrounding lines to make it unique.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "File relative to the project root" },
                old_text: { type: "string", description: "The exact text to replace" },
                new_text: { type: "string", description: "The text to put in its place" },
            },
            required: ["path", "old_text", "new_text"],
        },
    },
];

/**
 * Files of one workspace, as the agent sees them through its tools.
 */
export class WorkspaceTools {
    /** The files the agent changed, relative to the workspace, in the order it first changed them */
    public readonly changedFiles = new Set<string>();

    /**
     * @param root - The absolute path of the workspace
     * @param allowWrite - Whether the agent may change files, or only read them
     */
    public constructor(
        private readonly root: string,
        private readonly allowWrite: boolean,
    ) {}

    /** The tools the agent may use */
    public get definitions(): WorkspaceToolDefinition[] {
        return this.allowWrite ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
    }

    /**
     * Run a tool. A failure is returned as text starting with "Error:", for the agent to read and react to.
     */
    public async run(name: string, input: unknown): Promise<string> {
        const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
        try {
            switch (name) {
                case "workspace_list":
                    return await this.listFiles(stringArg(args, "path"));
                case "workspace_read":
                    return await this.readFile(stringArg(args, "path"), Number(args.offset) || 1);
                case "workspace_search":
                    return await this.search(stringArg(args, "pattern"), optionalStringArg(args, "path") ?? ".");
                case "workspace_write":
                    if (!this.allowWrite) break;
                    return await this.writeFile(stringArg(args, "path"), stringArg(args, "content"));
                case "workspace_edit":
                    if (!this.allowWrite) break;
                    return await this.editFile(
                        stringArg(args, "path"),
                        stringArg(args, "old_text"),
                        stringArg(args, "new_text"),
                    );
            }
            return `Error: there is no tool ${name}`;
        } catch (e) {
            return `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
    }

    /**
     * Turn a path of the agent into an absolute path inside the workspace.
     * @throws if the path leads outside the workspace, also through a link, or into its .git folder
     */
    public async resolve(relativePath: string): Promise<string> {
        const root = await fs.realpath(this.root);
        const absolute = path.resolve(root, relativePath);
        if (!isInside(root, absolute)) throw new Error(`${relativePath} is outside the project`);

        // Follow links of the deepest part that exists, so that a link can't lead out of the workspace
        let existing = absolute;
        while (!(await exists(existing))) existing = path.dirname(existing);
        const real = path.join(await fs.realpath(existing), path.relative(existing, absolute));
        if (!isInside(root, real)) throw new Error(`${relativePath} is outside the project`);
        if (path.relative(root, real).split(path.sep).includes(".git")) {
            throw new Error("the .git folder can't be used");
        }
        return real;
    }

    private async listFiles(folder: string): Promise<string> {
        const entries = await fs.readdir(await this.resolve(folder), { withFileTypes: true });
        const names = entries
            .filter((entry) => entry.name !== ".git")
            .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
            .sort();
        const shown = names.slice(0, MAX_ENTRIES);
        if (names.length > shown.length) shown.push(`… and ${names.length - shown.length} more`);
        return shown.join("\n") || "(empty folder)";
    }

    private async readFile(file: string, offset: number): Promise<string> {
        const absolute = await this.resolve(file);
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_FILE_SIZE) throw new Error(`${file} is too big to read`);
        const lines = (await fs.readFile(absolute, "utf8")).split(/\r?\n/);
        const start = Math.max(1, Math.floor(offset));
        const shown = lines.slice(start - 1, start - 1 + MAX_LINES).map((line, i) => `${start + i}\t${line}`);
        if (start - 1 + MAX_LINES < lines.length) {
            shown.push(`… ${lines.length - (start - 1 + MAX_LINES)} more lines; read on with offset`);
        }
        return shown.join("\n");
    }

    private async search(pattern: string, folder: string): Promise<string> {
        const regex = new RegExp(pattern, "i");
        const start = await this.resolve(folder);
        const root = await fs.realpath(this.root);
        const matches: string[] = [];

        const visit = async (dir: string): Promise<void> => {
            for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                if (matches.length >= MAX_MATCHES) return;
                const absolute = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (!SKIPPED_FOLDERS.has(entry.name)) await visit(absolute);
                    continue;
                }
                if (!entry.isFile() || (await fs.stat(absolute)).size > MAX_FILE_SIZE) continue;
                const text = await fs.readFile(absolute, "utf8");
                // Binary files have NUL characters, which text files don't
                if (text.includes("\0")) continue;
                const relative = path.relative(root, absolute).split(path.sep).join("/");
                text.split(/\r?\n/).forEach((line, i) => {
                    if (matches.length < MAX_MATCHES && regex.test(line)) {
                        matches.push(`${relative}:${i + 1}: ${line.trim().slice(0, 300)}`);
                    }
                });
            }
        };
        await visit(start);
        return matches.join("\n") || "No matches";
    }

    private async writeFile(file: string, content: string): Promise<string> {
        const absolute = await this.resolve(file);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content, "utf8");
        this.changedFiles.add(await this.relative(absolute));
        return `Wrote ${file}`;
    }

    private async editFile(file: string, oldText: string, newText: string): Promise<string> {
        const absolute = await this.resolve(file);
        const text = await fs.readFile(absolute, "utf8");
        // Files with Windows line endings are matched and kept with them
        const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
        const search = oldText.replace(/\r?\n/g, lineEnding);
        const count = text.split(search).length - 1;
        if (count !== 1) throw new Error(`old_text occurs ${count} times in ${file}, not once`);
        await fs.writeFile(
            absolute,
            text.replace(search, () => newText.replace(/\r?\n/g, lineEnding)),
            "utf8",
        );
        this.changedFiles.add(await this.relative(absolute));
        return `Edited ${file}`;
    }

    private async relative(absolute: string): Promise<string> {
        return path
            .relative(await fs.realpath(this.root), absolute)
            .split(path.sep)
            .join("/");
    }
}

function stringArg(args: Record<string, unknown>, name: string): string {
    const value = args[name];
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    return value;
}

function optionalStringArg(args: Record<string, unknown>, name: string): string | undefined {
    return args[name] === undefined ? undefined : stringArg(args, name);
}

function isInside(root: string, target: string): boolean {
    const relative = path.relative(root, target);
    const leaves = relative === ".." || relative.startsWith(`..${path.sep}`);
    return !leaves && !path.isAbsolute(relative);
}

async function exists(target: string): Promise<boolean> {
    try {
        await fs.lstat(target);
        return true;
    } catch {
        return false;
    }
}
