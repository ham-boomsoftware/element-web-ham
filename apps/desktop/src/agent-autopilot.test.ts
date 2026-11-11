/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, describe, it, beforeEach, afterEach } from "vitest";

import {
    buildPullRequestUrl,
    commitWorktree,
    createWorktree,
    getBranchDiff,
    git,
    parseDiff,
    pushBranch,
    removeWorktree,
    slugify,
} from "./agent-autopilot.js";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.org"];

describe("autopilot", () => {
    describe("slugify", () => {
        it.each([
            ["Fix the login bug!", "fix-the-login-bug"],
            ["Größe prüfen & Fehler beheben", "grosse-prufen-fehler-beheben"],
            ["   ", "task"],
            ["A very long title that goes on and on and on and on forever", "a-very-long-title-that-goes-on-and-on-an"],
        ])("turns %j into %j", (title, slug) => {
            expect(slugify(title)).toBe(slug);
        });
    });

    describe("buildPullRequestUrl", () => {
        it.each([
            ["git@github.com:octo/app.git", "https://github.com/octo/app/compare/main...pilot%2Ffix-1?expand=1"],
            [
                "https://user@github.com/octo/app.git",
                "https://github.com/octo/app/compare/main...pilot%2Ffix-1?expand=1",
            ],
            [
                "https://gitlab.com/group/app",
                "https://gitlab.com/group/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=pilot%2Ffix-1",
            ],
            [
                "git@ssh.dev.azure.com:v3/org/project/repo",
                "https://dev.azure.com/org/project/_git/repo/pullrequestcreate?sourceRef=pilot%2Ffix-1&targetRef=main",
            ],
            ["https://git.example.org/app.git", undefined],
            ["not a url", undefined],
        ])("links %s to %s", (remote, url) => {
            expect(buildPullRequestUrl(remote, "pilot/fix-1", "main")).toBe(url);
        });
    });

    describe("parseDiff", () => {
        it("reads added, changed, deleted, renamed and binary files", () => {
            const diff = [
                "diff --git a/src/app.ts b/src/app.ts",
                "index 1..2 100644",
                "--- a/src/app.ts",
                "+++ b/src/app.ts",
                "@@ -1,2 +1,2 @@",
                " const a = 1;",
                "-const b = 2;",
                "+const b = 3;",
                "\\ No newline at end of file",
                "diff --git a/new.ts b/new.ts",
                "new file mode 100644",
                "--- /dev/null",
                "+++ b/new.ts",
                "@@ -0,0 +1 @@",
                "+export {};",
                "diff --git a/old.ts b/old.ts",
                "deleted file mode 100644",
                "--- a/old.ts",
                "+++ /dev/null",
                "@@ -1 +0,0 @@",
                "-gone",
                "diff --git a/a.ts b/b.ts",
                "similarity index 100%",
                "rename from a.ts",
                "rename to b.ts",
                "diff --git a/logo.png b/logo.png",
                "Binary files a/logo.png and b/logo.png differ",
            ].join("\n");

            expect(parseDiff(diff)).toEqual([
                {
                    path: "src/app.ts",
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    truncated: false,
                    lines: [
                        { type: "hunk", text: "@@ -1,2 +1,2 @@" },
                        { type: "context", text: "const a = 1;" },
                        { type: "remove", text: "const b = 2;" },
                        { type: "add", text: "const b = 3;" },
                    ],
                },
                {
                    path: "new.ts",
                    status: "added",
                    additions: 1,
                    deletions: 0,
                    truncated: false,
                    lines: [
                        { type: "hunk", text: "@@ -0,0 +1 @@" },
                        { type: "add", text: "export {};" },
                    ],
                },
                {
                    path: "old.ts",
                    status: "deleted",
                    additions: 0,
                    deletions: 1,
                    truncated: false,
                    lines: [
                        { type: "hunk", text: "@@ -1 +0,0 @@" },
                        { type: "remove", text: "gone" },
                    ],
                },
                { path: "b.ts", status: "renamed", additions: 0, deletions: 0, truncated: false, lines: [] },
                { path: "logo.png", status: "modified", additions: 0, deletions: 0, truncated: true, lines: [] },
            ]);
        });

        it("cuts off a long file diff but still counts its lines", () => {
            const lines = Array.from({ length: 500 }, (_, i) => `+line ${i}`);
            const [file] = parseDiff(["diff --git a/x b/x", "@@ -0,0 +1,500 @@", ...lines].join("\n"));

            expect(file).toMatchObject({ additions: 500, truncated: true });
            expect(file.lines).toHaveLength(400);
        });
    });

    describe("working on a branch of its own", () => {
        let parent: string;
        let repository: string;
        let remote: string;

        beforeEach(async () => {
            parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-autopilot-")));
            repository = path.join(parent, "repo");
            remote = path.join(parent, "remote.git");
            await fs.mkdir(path.join(repository, "app"), { recursive: true });
            await git(parent, ["init", "-q", "--bare", remote]);
            await git(repository, ["init", "-q", "-b", "main"]);
            await fs.writeFile(path.join(repository, "app", "login.ts"), "export const ok = false;\n");
            await fs.writeFile(path.join(repository, "README.md"), "# App\n");
            await git(repository, ["add", "-A"]);
            await git(repository, [...IDENTITY, "commit", "-q", "-m", "Initial"]);
            await git(repository, ["remote", "add", "origin", remote]);
        });

        afterEach(async () => {
            await fs.rm(parent, { recursive: true, force: true });
        });

        it("creates a branch in a worktree, commits, pushes, shows the diff and cleans up", async () => {
            const worktree = await createWorktree(
                path.join(repository, "app"),
                path.join(parent, "worktrees"),
                "1a2b3c4d-task",
                "Fix the login",
            );

            expect(worktree.branch).toMatchObject({
                name: "pilot/fix-the-login-1a2b3c",
                base: "main",
                repositoryPath: repository,
                pushed: false,
            });
            // The agent works in the folder of the workspace inside the worktree
            expect(worktree.root).toBe(path.join(worktree.branch.worktreePath!, "app"));
            await fs.writeFile(path.join(worktree.root, "login.ts"), "export const ok = true;\n");
            await fs.writeFile(path.join(worktree.root, "test.ts"), "test();\n");

            // While the agent works, the diff shows what is not committed yet, also new files
            const live = await getBranchDiff(worktree.branch);
            expect(live.map((file) => [file.path, file.status])).toEqual([
                ["app/login.ts", "modified"],
                ["app/test.ts", "added"],
            ]);

            const committed = await commitWorktree(worktree.branch, "Fix the login\n\nIt works now");
            expect(committed.commit).toMatch(/^[0-9a-f]{40}$/);
            const pushed = await pushBranch(committed);
            expect(pushed).toMatchObject({ pushed: true, remote: "origin", pullRequestUrl: undefined });
            expect((await git(parent, [`--git-dir=${remote}`, "rev-parse", "pilot/fix-the-login-1a2b3c"])).trim()).toBe(
                committed.commit,
            );
            expect((await git(repository, ["log", "-1", "--format=%B", committed.commit!])).trim()).toBe(
                "Fix the login\n\nIt works now",
            );

            // The working tree of the user stays as it was
            expect(await fs.readFile(path.join(repository, "app", "login.ts"), "utf8")).toBe(
                "export const ok = false;\n",
            );
            expect((await git(repository, ["status", "--porcelain"])).trim()).toBe("");

            const removed = await removeWorktree(pushed);
            expect(removed.worktreePath).toBeUndefined();
            await expect(fs.access(worktree.branch.worktreePath!)).rejects.toThrow();
            // The committed branch stays, and its diff is read from the repository
            const diff = await getBranchDiff(removed);
            expect(diff.map((file) => [file.path, file.additions, file.deletions])).toEqual([
                ["app/login.ts", 1, 1],
                ["app/test.ts", 1, 0],
            ]);
        });

        it("commits nothing without changes and removes the empty branch with its worktree", async () => {
            const worktree = await createWorktree(repository, path.join(parent, "worktrees"), "task", "Look");

            const committed = await commitWorktree(worktree.branch, "Nothing");
            expect(committed.commit).toBeUndefined();

            await removeWorktree(committed);
            expect((await git(repository, ["branch", "--list", worktree.branch.name])).trim()).toBe("");
        });

        it("gives each run of a task a branch of its own", async () => {
            const first = await createWorktree(repository, path.join(parent, "worktrees"), "task", "Fix");
            const second = await createWorktree(repository, path.join(parent, "worktrees"), "task", "Fix");

            expect(first.branch.name).toBe("pilot/fix-task");
            expect(second.branch.name).toMatch(/^pilot\/fix-task-[0-9a-z]+$/);
        });

        it("keeps the commit when the push fails", async () => {
            await git(repository, ["remote", "set-url", "origin", path.join(parent, "missing.git")]);
            const worktree = await createWorktree(repository, path.join(parent, "worktrees"), "task", "Fix");
            await fs.writeFile(path.join(worktree.root, "README.md"), "# Changed\n");

            const pushed = await pushBranch(await commitWorktree(worktree.branch, "Change"));

            expect(pushed).toMatchObject({ pushed: false, remote: "origin", commit: expect.any(String) });
            expect(pushed.pushError).toBeTruthy();
        });

        it("fails outside of a git repository", async () => {
            const folder = path.join(parent, "plain");
            await fs.mkdir(folder);

            await expect(createWorktree(folder, path.join(parent, "worktrees"), "task", "Fix")).rejects.toThrow(
                /rev-parse/,
            );
        });
    });
});
