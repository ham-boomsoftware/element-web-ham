/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// The git side of the autopilot: it does a task on a branch of its own, in a separate worktree of the repository of
// the workspace, so that the working tree of the user is never touched. At the end it commits the changes and
// pushes the branch with the git login of the user.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDiffLine, AgentFileDiff, AgentRunBranch } from "shared-types";

/** How long a git command may take, except for a push */
const GIT_TIMEOUT_MS = 60 * 1000;

/** How long a push may take */
const PUSH_TIMEOUT_MS = 3 * 60 * 1000;

/** How many lines of a file diff are shown at most */
const MAX_DIFF_LINES_PER_FILE = 400;

/** How many files of a diff are shown at most */
const MAX_DIFF_FILES = 60;

/** The longest part of a task title in a branch name */
const MAX_SLUG_LENGTH = 40;

/** A failed git command, with what git wrote about it */
export class GitError extends Error {
    public constructor(
        public readonly args: string[],
        public readonly output: string,
    ) {
        super(`git ${args.join(" ")} failed: ${output.trim().slice(-500)}`);
        this.name = "GitError";
    }
}

/**
 * Run git in a folder.
 * @returns what git wrote to its standard output
 * @throws GitError if git fails
 */
export function git(cwd: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            "git",
            args,
            {
                cwd,
                timeout,
                maxBuffer: 32 * 1024 * 1024,
                windowsHide: true,
                // Never wait for a password prompt nobody can see
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
            },
            (error, stdout, stderr) => {
                if (error) reject(new GitError(args, `${stderr}\n${stdout}\n${error.message}`));
                else resolve(stdout);
            },
        );
    });
}

/**
 * Turn the title of a task into a part of a branch name: lower case letters, digits and dashes.
 */
export function slugify(title: string): string {
    const slug = title
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ß/g, "ss")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_SLUG_LENGTH)
        .replace(/-+$/, "");
    return slug || "task";
}

/** A worktree the autopilot works in */
export interface AutopilotWorktree {
    branch: AgentRunBranch;
    /** The folder of the workspace inside the worktree, where the agent works */
    root: string;
}

/**
 * Create a branch of its own for a task, checked out in a new worktree.
 * @param workspacePath - The workspace, the repository or a folder of it
 * @param worktreesPath - The folder the worktrees of the autopilot are kept in
 * @param taskId - The task
 * @param title - The title of the task, for the name of the branch
 * @throws GitError if the workspace is not in a git repository or the worktree can't be created
 */
export async function createWorktree(
    workspacePath: string,
    worktreesPath: string,
    taskId: string,
    title: string,
): Promise<AutopilotWorktree> {
    const repositoryPath = path.resolve((await git(workspacePath, ["rev-parse", "--show-toplevel"])).trim());
    const subPath = path.relative(await fs.realpath(repositoryPath), await fs.realpath(workspacePath));
    const baseCommit = (await git(repositoryPath, ["rev-parse", "HEAD"])).trim();
    const currentBranch = (await git(repositoryPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const base = currentBranch && currentBranch !== "HEAD" ? currentBranch : baseCommit.slice(0, 10);

    const id = taskId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 6) || "run";
    let name = `pilot/${slugify(title)}-${id}`;
    // A task can be done again: each run gets a new branch
    if (await branchExists(repositoryPath, name)) name = `${name}-${Date.now().toString(36)}`;

    await fs.mkdir(worktreesPath, { recursive: true });
    const worktreePath = path.join(worktreesPath, `${id}-${Date.now().toString(36)}`);
    await git(repositoryPath, ["worktree", "add", "-b", name, worktreePath, baseCommit]);
    return {
        branch: { name, base, baseCommit, repositoryPath, worktreePath, pushed: false },
        root: path.join(worktreePath, subPath),
    };
}

async function branchExists(repositoryPath: string, name: string): Promise<boolean> {
    try {
        await git(repositoryPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
        return true;
    } catch {
        return false;
    }
}

/**
 * Commit all changes in the worktree of the branch.
 * @param message - The commit message
 * @returns the branch with its commit, or unchanged if there was nothing to commit
 */
export async function commitWorktree(branch: AgentRunBranch, message: string): Promise<AgentRunBranch> {
    const cwd = branch.worktreePath;
    if (!cwd) return branch;
    await git(cwd, ["add", "-A"]);
    if (!(await git(cwd, ["status", "--porcelain"])).trim()) return branch;

    // Without a git identity of the user, the commit is made in the name of the autopilot
    const identity = (await hasIdentity(cwd))
        ? []
        : ["-c", "user.name=Element Pilot", "-c", "user.email=pilot@element.invalid"];
    // Hooks of the project could ask for input or take long; the user can run them on the branch
    await git(cwd, [...identity, "commit", "--no-verify", "-q", "-m", message]);
    const commit = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    return { ...branch, commit };
}

async function hasIdentity(cwd: string): Promise<boolean> {
    try {
        return Boolean((await git(cwd, ["config", "user.email"])).trim());
    } catch {
        return false;
    }
}

/**
 * Push the branch with the git login of the user, to `origin` or else the first remote.
 * @returns the branch, pushed or with why it couldn't be pushed
 */
export async function pushBranch(branch: AgentRunBranch): Promise<AgentRunBranch> {
    const cwd = branch.worktreePath ?? branch.repositoryPath;
    let remote: string | undefined;
    try {
        const remotes = (await git(cwd, ["remote"])).split(/\r?\n/).filter(Boolean);
        remote = remotes.includes("origin") ? "origin" : remotes[0];
        if (!remote) return { ...branch, pushed: false, pushError: "The repository has no remote" };
        await git(cwd, ["push", "-u", remote, `${branch.name}:${branch.name}`], PUSH_TIMEOUT_MS);
        const url = (await git(cwd, ["remote", "get-url", remote])).trim();
        return {
            ...branch,
            pushed: true,
            remote,
            pushError: undefined,
            pullRequestUrl: buildPullRequestUrl(url, branch.name, branch.base),
        };
    } catch (e) {
        const message = e instanceof GitError ? e.output.trim().slice(-500) : String(e);
        return { ...branch, pushed: false, remote, pushError: message || "git push failed" };
    }
}

/**
 * The web address to open a pull request for a pushed branch, for repositories on GitHub, GitLab and Azure DevOps.
 * @param remoteUrl - The URL of the remote, as https or ssh
 * @param branch - The pushed branch
 * @param base - The branch to merge into
 */
export function buildPullRequestUrl(remoteUrl: string, branch: string, base: string): string | undefined {
    const web = toWebUrl(remoteUrl);
    if (!web) return undefined;
    const source = encodeURIComponent(branch);
    if (web.host === "github.com") {
        return `https://github.com${web.path}/compare/${encodeURIComponent(base)}...${source}?expand=1`;
    }
    if (web.host === "gitlab.com") {
        return `https://gitlab.com${web.path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${source}`;
    }
    if (web.host === "dev.azure.com" || web.host.endsWith(".visualstudio.com")) {
        return `https://${web.host}${web.path}/pullrequestcreate?sourceRef=${source}&targetRef=${encodeURIComponent(base)}`;
    }
    return undefined;
}

function toWebUrl(remoteUrl: string): { host: string; path: string } | undefined {
    const url = remoteUrl.trim();
    // scp-like ssh: git@github.com:owner/repo.git
    const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(url);
    let host: string;
    let repoPath: string;
    if (scp && !url.includes("://")) {
        [, host, repoPath] = scp;
        repoPath = `/${repoPath}`;
    } else {
        try {
            const parsed = new URL(url);
            host = parsed.hostname;
            repoPath = parsed.pathname;
        } catch {
            return undefined;
        }
    }
    host = host.toLowerCase();
    repoPath = repoPath.replace(/\.git$/, "").replace(/\/+$/, "");
    // Azure DevOps over ssh: ssh.dev.azure.com:v3/org/project/repo
    if (host === "ssh.dev.azure.com") {
        const parts = repoPath.replace(/^\/v3\//, "").split("/");
        if (parts.length !== 3) return undefined;
        return { host: "dev.azure.com", path: `/${parts[0]}/${parts[1]}/_git/${parts[2]}` };
    }
    return { host, path: repoPath };
}

/**
 * The changes on the branch: against the commit it started from, with what is not committed yet while the
 * autopilot still works on it.
 */
export async function getBranchDiff(branch: AgentRunBranch): Promise<AgentFileDiff[]> {
    const args = ["-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff", "-M"];
    if (branch.worktreePath && (await exists(branch.worktreePath))) {
        // New files only show in the diff once git knows about them
        await git(branch.worktreePath, ["add", "-A", "-N"]);
        return parseDiff(await git(branch.worktreePath, [...args, branch.baseCommit]));
    }
    if (!branch.commit) return [];
    return parseDiff(await git(branch.repositoryPath, [...args, branch.baseCommit, branch.commit]));
}

/**
 * Read the output of `git diff` into the changes of each file.
 */
export function parseDiff(text: string): AgentFileDiff[] {
    const files: AgentFileDiff[] = [];
    let file: AgentFileDiff | undefined;
    let inHunk = false;

    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
            if (files.length >= MAX_DIFF_FILES) break;
            const match = /^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/.exec(line);
            file = {
                path: match?.[2] ?? line.slice("diff --git ".length),
                status: "modified",
                additions: 0,
                deletions: 0,
                lines: [],
                truncated: false,
            };
            files.push(file);
            inHunk = false;
            continue;
        }
        if (!file) continue;

        if (!inHunk) {
            if (line.startsWith("new file mode")) file.status = "added";
            else if (line.startsWith("deleted file mode")) file.status = "deleted";
            else if (line.startsWith("rename to ")) {
                file.status = "renamed";
                file.path = line.slice("rename to ".length);
            } else if (line.startsWith("Binary files")) file.truncated = true;
        }

        if (line.startsWith("@@")) {
            inHunk = true;
            pushLine(file, { type: "hunk", text: line });
        } else if (inHunk && line.startsWith("+")) {
            file.additions++;
            pushLine(file, { type: "add", text: line.slice(1) });
        } else if (inHunk && line.startsWith("-")) {
            file.deletions++;
            pushLine(file, { type: "remove", text: line.slice(1) });
        } else if (inHunk && line.startsWith(" ")) {
            pushLine(file, { type: "context", text: line.slice(1) });
        }
    }
    return files;
}

function pushLine(file: AgentFileDiff, line: AgentDiffLine): void {
    if (file.lines.length < MAX_DIFF_LINES_PER_FILE) file.lines.push(line);
    else file.truncated = true;
}

/**
 * Remove the worktree of a branch. A branch without a commit is removed as well; a committed branch is kept.
 * @returns the branch without its worktree
 */
export async function removeWorktree(branch: AgentRunBranch): Promise<AgentRunBranch> {
    const { worktreePath, repositoryPath } = branch;
    if (worktreePath) {
        try {
            await git(repositoryPath, ["worktree", "remove", "--force", worktreePath]);
        } catch (e) {
            console.warn("Failed to remove the worktree with git", e);
        }
        await fs.rm(worktreePath, { recursive: true, force: true });
        await git(repositoryPath, ["worktree", "prune"]).catch(() => undefined);
    }
    if (!branch.commit) await git(repositoryPath, ["branch", "-D", branch.name]).catch(() => undefined);
    return { ...branch, worktreePath: undefined };
}

async function exists(target: string): Promise<boolean> {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}
