/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, describe, it, beforeEach, afterEach } from "vitest";

import { WorkspaceTools } from "./agent-workspace.js";

describe("WorkspaceTools", () => {
    let parent: string;
    let root: string;

    beforeEach(async () => {
        parent = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workspace-"));
        root = path.join(parent, "project");
        await fs.mkdir(path.join(root, "src"), { recursive: true });
        await fs.mkdir(path.join(root, ".git"));
        await fs.mkdir(path.join(root, "node_modules", "lib"), { recursive: true });
        await fs.writeFile(path.join(root, "src", "app.ts"), "const greeting = 'Hello';\nconsole.log(greeting);\n");
        await fs.writeFile(path.join(root, "README.md"), "# Project\r\nSay Hello\r\n");
        await fs.writeFile(path.join(root, ".git", "config"), "[core]");
        await fs.writeFile(path.join(root, "node_modules", "lib", "index.js"), "Hello from a dependency");
        await fs.writeFile(path.join(parent, "secret.txt"), "outside");
    });

    afterEach(async () => {
        await fs.rm(parent, { recursive: true, force: true });
    });

    it("only offers the reading tools when it may not write", () => {
        expect(new WorkspaceTools(root, false).definitions.map((tool) => tool.name)).toEqual([
            "workspace_list",
            "workspace_read",
            "workspace_search",
        ]);
        expect(new WorkspaceTools(root, true).definitions.map((tool) => tool.name)).toEqual([
            "workspace_list",
            "workspace_read",
            "workspace_search",
            "workspace_write",
            "workspace_edit",
        ]);
    });

    it("lists a folder without the .git folder", async () => {
        const tools = new WorkspaceTools(root, false);

        expect(await tools.run("workspace_list", { path: "." })).toBe("README.md\nnode_modules/\nsrc/");
    });

    it("reads a file with line numbers, from an offset", async () => {
        const tools = new WorkspaceTools(root, false);

        expect(await tools.run("workspace_read", { path: "src/app.ts" })).toBe(
            "1\tconst greeting = 'Hello';\n2\tconsole.log(greeting);\n3\t",
        );
        expect(await tools.run("workspace_read", { path: "src/app.ts", offset: 2 })).toBe(
            "2\tconsole.log(greeting);\n3\t",
        );
    });

    it("searches the project but not its dependencies or .git", async () => {
        const tools = new WorkspaceTools(root, false);

        expect(await tools.run("workspace_search", { pattern: "hello" })).toBe(
            "README.md:2: Say Hello\nsrc/app.ts:1: const greeting = 'Hello';",
        );
        expect(await tools.run("workspace_search", { pattern: "nothing like this" })).toBe("No matches");
    });

    it.each([
        ["a path outside the project", { path: "../secret.txt" }],
        ["an absolute path outside the project", { path: "ABSOLUTE" }],
        ["the .git folder", { path: ".git/config" }],
    ])("refuses to read %s", async (_, input) => {
        const tools = new WorkspaceTools(root, false);
        // The temporary folder is only known once the test runs
        const file = input.path === "ABSOLUTE" ? path.join(parent, "secret.txt") : input.path;

        expect(await tools.run("workspace_read", { path: file })).toMatch(/^Error: /);
    });

    it("refuses to write when it may only read", async () => {
        const tools = new WorkspaceTools(root, false);

        expect(await tools.run("workspace_write", { path: "new.txt", content: "x" })).toBe(
            "Error: there is no tool workspace_write",
        );
        await expect(fs.access(path.join(root, "new.txt"))).rejects.toThrow();
    });

    it("writes new files in new folders and remembers them", async () => {
        const tools = new WorkspaceTools(root, true);

        expect(await tools.run("workspace_write", { path: "docs/notes.md", content: "Notes" })).toBe(
            "Wrote docs/notes.md",
        );

        expect(await fs.readFile(path.join(root, "docs", "notes.md"), "utf8")).toBe("Notes");
        expect([...tools.changedFiles]).toEqual(["docs/notes.md"]);
    });

    it("edits a file, keeping its Windows line endings", async () => {
        const tools = new WorkspaceTools(root, true);

        expect(
            await tools.run("workspace_edit", {
                path: "README.md",
                old_text: "# Project\nSay",
                new_text: "# App\nSay",
            }),
        ).toBe("Edited README.md");

        expect(await fs.readFile(path.join(root, "README.md"), "utf8")).toBe("# App\r\nSay Hello\r\n");
        expect([...tools.changedFiles]).toEqual(["README.md"]);
    });

    it("refuses an edit whose text does not occur exactly once", async () => {
        const tools = new WorkspaceTools(root, true);

        expect(await tools.run("workspace_edit", { path: "src/app.ts", old_text: "greeting", new_text: "x" })).toBe(
            "Error: old_text occurs 2 times in src/app.ts, not once",
        );
        expect(tools.changedFiles.size).toBe(0);
    });

    it("refuses to write outside the project or into .git", async () => {
        const tools = new WorkspaceTools(root, true);

        expect(await tools.run("workspace_write", { path: "../evil.txt", content: "x" })).toMatch(/^Error: /);
        expect(await tools.run("workspace_write", { path: ".git/hooks/pre-commit", content: "x" })).toMatch(/^Error: /);
        await expect(fs.access(path.join(parent, "evil.txt"))).rejects.toThrow();
    });

    it("reports invalid input as an error", async () => {
        const tools = new WorkspaceTools(root, true);

        expect(await tools.run("workspace_read", { path: 3 })).toBe("Error: path must be a string");
        expect(await tools.run("workspace_read", null)).toBe("Error: path must be a string");
    });
});
