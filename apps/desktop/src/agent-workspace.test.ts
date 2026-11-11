/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, describe, it, beforeEach, afterEach, vi } from "vitest";

import { MAX_QUESTIONS, readProjectGuides, WorkspaceTools } from "./agent-workspace.js";

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

    describe("running commands", () => {
        const ALLOWED = "node -e \"console.log(require('fs').readdirSync('.').sort().join(','))\"";
        const FAILING = "node -e \"console.error('broken'); process.exit(3)\"";

        it("offers workspace_run with the allowed commands only when it may write", () => {
            const reading = new WorkspaceTools(root, false, { commands: [ALLOWED] });
            const writing = new WorkspaceTools(root, true, { commands: [ALLOWED] });

            expect(reading.definitions.map((tool) => tool.name)).not.toContain("workspace_run");
            expect(writing.definitions.at(-1)).toMatchObject({ name: "workspace_run" });
            expect(writing.definitions.at(-1)?.description).toContain(`- ${ALLOWED}`);
        });

        it("runs an allowed command in the project and reports its exit code, output and step", async () => {
            const onStep = vi.fn();
            const tools = new WorkspaceTools(root, true, { commands: [ALLOWED, FAILING], onStep });

            expect(await tools.run("workspace_run", { command: ` ${ALLOWED} ` })).toBe(
                "Exit code 0\n.git,README.md,node_modules,src",
            );
            expect(await tools.run("workspace_run", { command: FAILING })).toBe("Exit code 3\nbroken");
            expect(onStep.mock.calls.map(([step]) => [step.kind, step.text, step.failed])).toEqual([
                ["command", ALLOWED, undefined],
                ["command", FAILING, true],
            ]);
        });

        it("refuses a command that is not exactly an allowed one", async () => {
            const tools = new WorkspaceTools(root, true, { commands: [ALLOWED] });

            expect(await tools.run("workspace_run", { command: `${ALLOWED} && echo hacked` })).toMatch(
                /^Error: ".*" is not allowed/,
            );
            expect(await new WorkspaceTools(root, true).run("workspace_run", { command: ALLOWED })).toBe(
                "Error: there is no tool workspace_run",
            );
        });
    });

    it("tells about each tool it runs", async () => {
        const onStep = vi.fn();
        const tools = new WorkspaceTools(root, true, { onStep });

        await tools.run("workspace_read", { path: "src/app.ts" });
        await tools.run("workspace_search", { pattern: "Hello", path: "src" });
        await tools.run("workspace_edit", { path: "src/app.ts", old_text: "missing", new_text: "x" });

        expect(onStep.mock.calls.map(([step]) => [step.kind, step.text, step.failed])).toEqual([
            ["read", "src/app.ts", undefined],
            ["search", "Hello", undefined],
            ["edit", "src/app.ts", true],
        ]);
    });

    describe("asking who asked for the task", () => {
        it("offers the tool only when it can ask, also when it only reads", () => {
            const ask = vi.fn();

            expect(new WorkspaceTools(root, false, { ask }).definitions.map((tool) => tool.name)).toContain(
                "ask_requester",
            );
            expect(new WorkspaceTools(root, true).definitions.map((tool) => tool.name)).not.toContain("ask_requester");
        });

        it("gives the agent the answer, or tells it to decide by itself, and counts the wait", async () => {
            vi.useFakeTimers({ toFake: ["Date"] });
            const ask = vi.fn(async () => {
                vi.setSystemTime(Date.now() + 60_000);
                return "";
            });
            ask.mockResolvedValueOnce("  The blue one ");
            const tools = new WorkspaceTools(root, false, { ask });

            expect(await tools.run("ask_requester", { question: " Which colour? " })).toBe("The answer: The blue one");
            expect(await tools.run("ask_requester", { question: "And the size?" })).toMatch(/^No answer came/);

            expect(ask).toHaveBeenCalledWith("Which colour?");
            expect(tools.waitedMs).toBe(60_000);
            vi.useRealTimers();
        });

        it(`asks at most ${MAX_QUESTIONS} questions, and no empty ones`, async () => {
            const ask = vi.fn().mockResolvedValue("Yes");
            const tools = new WorkspaceTools(root, false, { ask });

            expect(await tools.run("ask_requester", { question: "  " })).toBe("Error: the question is empty");
            for (let i = 0; i < MAX_QUESTIONS; i++) await tools.run("ask_requester", { question: `Question ${i}` });
            expect(await tools.run("ask_requester", { question: "One more?" })).toMatch(/^Error: you already asked/);

            expect(ask).toHaveBeenCalledTimes(MAX_QUESTIONS);
            expect(await new WorkspaceTools(root, false).run("ask_requester", { question: "Hi?" })).toBe(
                "Error: there is no tool ask_requester",
            );
        });
    });
});

describe("readProjectGuides", () => {
    let parent: string;
    let root: string;

    beforeEach(async () => {
        parent = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guides-"));
        root = path.join(parent, "project");
        await fs.mkdir(path.join(root, ".github"), { recursive: true });
    });

    afterEach(async () => {
        await fs.rm(parent, { recursive: true, force: true });
    });

    it("reads the guides the project has, the most specific first, and skips empty ones", async () => {
        await fs.writeFile(path.join(root, "CONTRIBUTING.md"), "Write tests.\n");
        await fs.writeFile(path.join(root, "AGENTS.md"), "  Use 4 spaces.  \n");
        await fs.writeFile(path.join(root, ".github", "copilot-instructions.md"), "\n\n");

        expect(await readProjectGuides(root)).toEqual([
            { path: "AGENTS.md", text: "Use 4 spaces.", truncated: false },
            { path: "CONTRIBUTING.md", text: "Write tests.", truncated: false },
        ]);
    });

    it("has no guides for a project without them, or a folder that doesn't exist", async () => {
        expect(await readProjectGuides(root)).toEqual([]);
        expect(await readProjectGuides(path.join(parent, "missing"))).toEqual([]);
    });

    it("cuts long guides, and reads a guide linked from another name once", async () => {
        await fs.writeFile(path.join(root, "AGENTS.md"), "x".repeat(20_000));
        await fs.copyFile(path.join(root, "AGENTS.md"), path.join(root, "CONTRIBUTING.md"));
        // Links need extra rights on Windows; the copy is read as its own guide
        const linked = await fs
            .symlink(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"))
            .then(() => true)
            .catch(() => false);

        const guides = await readProjectGuides(root);

        expect(guides.map((guide) => guide.path)).toEqual(["AGENTS.md", "CONTRIBUTING.md"]);
        expect(guides[0]).toMatchObject({ truncated: true });
        expect(guides[0].text).toHaveLength(12_000);
        // All guides together are cut too
        expect(guides[1].text.length).toBeLessThan(20_000);
        if (linked) expect(guides.map((guide) => guide.path)).not.toContain("CLAUDE.md");
    });

    it("doesn't read a guide that leads outside the project", async () => {
        await fs.writeFile(path.join(parent, "secret.md"), "secret");
        // Windows may not allow symlinks without admin rights; then there is no guide either
        await fs.symlink(path.join(parent, "secret.md"), path.join(root, "AGENTS.md")).catch(() => {});

        expect(await readProjectGuides(root)).toEqual([]);
    });
});
