/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Imports the bug tickets of BSM, the Boom Support Manager, that are not closed into the user's to-do list, so that
// the agent can look into them in the project folder of the customer's application.
//
// BSM has a personal API for its tickets, which answers with the login of the user's browser session. The user logs
// in once in a window of the app, in a session of its own that is kept, and the app calls the API from a hidden page
// of BSM in that session. The app never sees the password.

import { BrowserWindow, session } from "electron";
import type { AgentResult, AgentTask, AgentTicketRef } from "shared-types";

import { failure, getAgentStore, isDirectory } from "./agent.js";
import { saveTicketTask, setAgentTaskWorkspace, type TicketTaskInput } from "./agent-tasks.js";

/** The address of BSM */
export const BSM_URL = "https://bsm.boomsoftware.com";

/** The session the user is logged in to BSM with; `persist:` keeps it after the app closes */
const BSM_PARTITION = "persist:agent-bsm";

/** The states of a ticket that count as closed; the others, such as `inprocess` or `delivered`, are still open */
const CLOSED_STATES = new Set(["completed", "archived", "closed", "rejected", "cancelled", "canceled"]);

/** The states of the bug tickets that are imported */
export const OPEN_STATES = ["new", "inprocess", "delivered"];

/** How many tickets one query returns at most; the API allows up to 5000 */
const QUERY_LIMIT = 500;

/** How many queries one import makes at most, so that a wrong answer can't make it loop */
const MAX_QUERIES = 20;

/** How much of a comment the task shows */
const MAX_COMMENT_LENGTH = 600;

/** A comment of a conversation of a ticket */
interface BsmComment {
    CommentText?: string | null;
    CreateDate?: string;
    CreateBy?: string | null;
    ChildComments?: BsmComment[] | null;
}

/** A ticket as the personal API of BSM returns it, with the fields used here */
export interface BsmIndication {
    Number?: string;
    Link?: string | null;
    ApplicationName?: string | null;
    ProjectName?: string | null;
    Summary?: string | null;
    Description?: string | null;
    MainCategoryName?: string | null;
    CategoryName?: string | null;
    Status?: string;
    InstallationName?: string | null;
    ChangeDate?: string;
    Reporter?: string | null;
    Handler?: string | null;
    Conversations?: { Name?: string | null; Comments?: BsmComment[] | null }[] | null;
}

/** A user the API names by username */
export interface BsmUser {
    Username?: string;
    Name?: string | null;
}

/** The answer of `POST /personal/api/queryIndications` */
export interface BsmQueryResponse {
    Indications?: BsmIndication[] | null;
    Users?: BsmUser[] | null;
    LimitExceeded?: boolean;
}

/** The answer of `GET /personal/api/indication/{number}` */
export interface BsmTicket {
    Indication?: BsmIndication;
    Users?: BsmUser[] | null;
}

/** What the import needs from the app, so that it can be tested without one */
export interface BsmImportDeps {
    /** The bug tickets that are not closed, with their descriptions and conversations */
    queryOpenBugs(): Promise<{ indications: BsmIndication[]; users: BsmUser[] }>;
    /** One ticket, to find out whether a ticket the list no longer has was closed */
    readTicket(number: string): Promise<BsmTicket>;
    /** The tickets of the open tasks of the to-do list */
    getOpenTicketNumbers(): string[];
    /** When each ticket last changed at the last import */
    getSeen(): Record<string, string>;
    setSeen(seen: Record<string, string>): void;
    /** The project folder of an application, if the user set one */
    getProjectFolder(application: string): string | undefined;
    saveTask(input: TicketTaskInput): { task: AgentTask; added: boolean } | undefined;
}

/** What an import did */
export interface BsmImportResult {
    /** How many open bug tickets BSM has */
    listed: number;
    added: AgentTask[];
    updated: AgentTask[];
    /** The tasks whose ticket was closed in BSM, which are now done */
    closed: AgentTask[];
    /** The applications of open tickets without a project folder */
    withoutFolder: string[];
    /** The tickets that couldn't be read, with why */
    errors: string[];
}

export class BsmLoginError extends Error {
    public constructor() {
        super("Not logged in to BSM");
    }
}

/** Whether a state of a ticket counts as open: anything but closed, so also a fix delivered but not confirmed */
export function isOpenState(status: string | undefined): boolean {
    return Boolean(status) && !CLOSED_STATES.has(status!.toLowerCase());
}

/** The body of the query for the bug tickets that are not closed */
export function buildOpenBugsQuery(offset: number): Record<string, unknown> {
    return {
        filter: { mainCategoryFilter: "ErrorMessage", statusFilter: OPEN_STATES },
        details: { includeLink: true, includeDescription: true, includeConversations: true },
        limit: QUERY_LIMIT,
        offset,
    };
}

function flattenComments(comments: BsmComment[] | null | undefined): BsmComment[] {
    return (comments ?? []).flatMap((comment) => [comment, ...flattenComments(comment.ChildComments)]);
}

/** Turn a ticket of BSM into the text of a task: what is asked, and the conversations about it, oldest first */
export function describeTicket(t: BsmIndication, users: BsmUser[] = []): string {
    const names = new Map(users.map((user) => [user.Username ?? "", user.Name ?? user.Username ?? ""]));
    const name = (username: string | null | undefined): string => names.get(username ?? "") || username || "?";
    const lines = [
        `BSM ticket ${t.Number}: ${t.Summary ?? ""}`,
        t.Link ?? `${BSM_URL}/indication/${t.Number}`,
        [
            t.ApplicationName && `Application: ${t.ApplicationName}`,
            t.InstallationName && `Installation: ${t.InstallationName}`,
            t.Status && `State: ${t.Status}`,
            [t.MainCategoryName, t.CategoryName].filter(Boolean).join(" / "),
        ]
            .filter(Boolean)
            .join(" · "),
        `Reporter: ${name(t.Reporter)} · Handler: ${name(t.Handler)}`,
        "",
        (t.Description ?? "").trim(),
    ];
    for (const conversation of t.Conversations ?? []) {
        const comments = flattenComments(conversation.Comments)
            .filter((comment) => comment.CommentText)
            .sort((a, b) => (a.CreateDate ?? "").localeCompare(b.CreateDate ?? ""));
        if (comments.length === 0) continue;
        lines.push("", `Conversation "${conversation.Name ?? ""}":`);
        for (const comment of comments) {
            const text = comment.CommentText!.trim().replace(/\s+\n/g, "\n").slice(0, MAX_COMMENT_LENGTH);
            lines.push(`- ${(comment.CreateDate ?? "").slice(0, 10)} ${name(comment.CreateBy)}: ${text}`);
        }
    }
    return lines.join("\n");
}

/** The reference of the task to a ticket of BSM */
export function toTicketRef(t: BsmIndication): AgentTicketRef {
    return {
        system: "bsm",
        number: t.Number ?? "",
        url: t.Link ?? `${BSM_URL}/indication/${t.Number}`,
        application: t.ApplicationName ?? undefined,
        status: t.Status,
        changedAt: t.ChangeDate,
    };
}

function toTaskInput(t: BsmIndication, users: BsmUser[], folder: string | undefined): TicketTaskInput {
    return {
        ticket: toTicketRef(t),
        title: `${t.Number}: ${t.Summary ?? ""}`,
        details: describeTicket(t, users),
        workspacePath: folder,
        closed: !isOpenState(t.Status),
    };
}

/**
 * Add the bug tickets of BSM that are not closed, and are new or changed since the last import, to the to-do list.
 * The task of a ticket that is no longer open is marked as done once BSM says it is closed.
 */
export async function importBsmTickets(deps: BsmImportDeps): Promise<BsmImportResult> {
    const { indications, users } = await deps.queryOpenBugs();
    const seen = { ...deps.getSeen() };
    const result: BsmImportResult = {
        listed: indications.length,
        added: [],
        updated: [],
        closed: [],
        withoutFolder: [],
        errors: [],
    };
    const withoutFolder = new Set<string>();
    const open = new Set<string>();
    for (const t of indications) {
        if (!t.Number) continue;
        open.add(t.Number);
        if (seen[t.Number] && seen[t.Number] === t.ChangeDate) continue;
        const folder = t.ApplicationName ? deps.getProjectFolder(t.ApplicationName) : undefined;
        const saved = deps.saveTask(toTaskInput(t, users, folder));
        if (t.ChangeDate) seen[t.Number] = t.ChangeDate;
        if (!saved) continue;
        (saved.added ? result.added : result.updated).push(saved.task);
        if (!saved.task.workspacePath && t.ApplicationName) withoutFolder.add(t.ApplicationName);
    }

    // A ticket of an open task that the query no longer returns was closed, or isn't a bug any more
    for (const number of deps.getOpenTicketNumbers()) {
        if (open.has(number)) continue;
        try {
            const ticket = await deps.readTicket(number);
            if (!ticket.Indication || isOpenState(ticket.Indication.Status)) continue;
            const saved = deps.saveTask(toTaskInput(ticket.Indication, ticket.Users ?? [], undefined));
            if (saved) result.closed.push(saved.task);
            delete seen[number];
        } catch (e) {
            if (e instanceof BsmLoginError) throw e;
            result.errors.push(`${number}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    deps.setSeen(seen);
    result.withoutFolder = [...withoutFolder].sort();
    return result;
}

// ---- The app: the session and windows for BSM ----

let sessionPrepared = false;

function getBsmSession(): Electron.Session {
    const ses = session.fromPartition(BSM_PARTITION);
    if (!sessionPrepared) {
        sessionPrepared = true;
        // A login page can ask Windows to open an app for a link, such as Edge for a single sign-on; the windows of
        // BSM stay in the app, so such requests are refused
        ses.setPermissionRequestHandler((_webContents, permission, callback) =>
            callback(permission !== "openExternal"),
        );
    }
    return ses;
}

/** Whether a page is not of BSM: the user is sent to a login, of BSM or of another sign-in service */
export function isLoginPage(url: string): boolean {
    try {
        const { hostname } = new URL(url);
        return hostname !== new URL(BSM_URL).hostname || url.includes("LoginOAuth=");
    } catch {
        return false;
    }
}

/** Keep the links of BSM pages in the window: opening new windows or other apps is refused */
function keepInWindow(win: BrowserWindow): void {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

/** Load a page; a navigation that a script of the page interrupts, such as to the login, is not an error here */
async function load(win: BrowserWindow, url: string): Promise<void> {
    try {
        await win.loadURL(url);
    } catch (e) {
        console.log(`BSM: loading ${url} ended at ${win.webContents.getURL()}`, e instanceof Error ? e.message : e);
    }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls the personal API of BSM from a hidden page of BSM, with the login of the session */
class BsmApi {
    private constructor(private readonly win: BrowserWindow) {}

    /** Open a hidden page of BSM; fails with a {@link BsmLoginError} if the user is not logged in */
    public static async open(): Promise<BsmApi> {
        getBsmSession();
        const win = new BrowserWindow({
            show: false,
            webPreferences: { partition: BSM_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        keepInWindow(win);
        await load(win, `${BSM_URL}/#Home`);
        // Without a login, the page sends the browser to the login with a script
        await sleep(500);
        if (isLoginPage(win.webContents.getURL())) {
            console.log(`BSM: not logged in, the page went to ${new URL(win.webContents.getURL()).host}`);
            win.destroy();
            throw new BsmLoginError();
        }
        return new BsmApi(win);
    }

    public close(): void {
        this.win.destroy();
    }

    /** Call the API with the session of the page; the body and path are JSON-encoded, never put into the script */
    private async call(method: "GET" | "POST", apiPath: string, body?: unknown): Promise<unknown> {
        const script = `(async () => {
            const r = await fetch(${JSON.stringify(apiPath)}, {
                method: ${JSON.stringify(method)},
                credentials: "include",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                ${body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(body))},`}
            });
            return { status: r.status, text: await r.text() };
        })()`;
        const { status, text } = (await this.win.webContents.executeJavaScript(script)) as {
            status: number;
            text: string;
        };
        if (status === 401 || status === 403) throw new BsmLoginError();
        if (status !== 200) throw new Error(`BSM answered ${status} for ${apiPath}`);
        try {
            return JSON.parse(text);
        } catch {
            // A login page instead of the answer
            throw new BsmLoginError();
        }
    }

    public async queryOpenBugs(): Promise<{ indications: BsmIndication[]; users: BsmUser[] }> {
        const indications: BsmIndication[] = [];
        const users = new Map<string, BsmUser>();
        for (let page = 0; page < MAX_QUERIES; page++) {
            const answer = (await this.call(
                "POST",
                "/personal/api/queryIndications",
                buildOpenBugsQuery(indications.length),
            )) as BsmQueryResponse;
            const found = answer.Indications ?? [];
            indications.push(...found);
            for (const user of answer.Users ?? []) users.set(user.Username ?? "", user);
            if (!answer.LimitExceeded || found.length === 0) break;
        }
        console.log(`BSM: ${indications.length} open bug tickets`);
        return { indications, users: [...users.values()] };
    }

    public async readTicket(number: string): Promise<BsmTicket> {
        return (await this.call("GET", `/personal/api/indication/${encodeURIComponent(number)}`)) as BsmTicket;
    }
}

function getProjectFolder(application: string): string | undefined {
    const folder = getAgentStore().get("bsmProjects")?.[application];
    return folder && isDirectory(folder) ? folder : undefined;
}

/**
 * Open a window of BSM for the user to log in. The login is kept in a session of its own.
 * @returns once the user closed the window
 */
export async function loginToBsm(parent?: BrowserWindow): Promise<AgentResult<void>> {
    getBsmSession();
    const win = new BrowserWindow({
        width: 1100,
        height: 800,
        title: "BSM – anmelden und Fenster schließen",
        parent,
        autoHideMenuBar: true,
        webPreferences: { partition: BSM_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    keepInWindow(win);
    win.on("page-title-updated", (e) => e.preventDefault());
    const closed = new Promise<void>((resolve) => win.on("closed", () => resolve()));
    console.log("BSM: opened the login window");
    await load(win, `${BSM_URL}/#Indications`);
    await closed;
    return { ok: true, data: undefined };
}

/**
 * Import the bug tickets of BSM that are not closed into the to-do list of a user.
 */
export async function importBsmTicketsForUser(userId: string): Promise<AgentResult<BsmImportResult>> {
    let api: BsmApi | undefined;
    try {
        api = await BsmApi.open();
        const opened = api;
        const result = await importBsmTickets({
            queryOpenBugs: () => opened.queryOpenBugs(),
            readTicket: (number) => opened.readTicket(number),
            getOpenTicketNumbers: () =>
                (getAgentStore().get("tasks")?.[userId] ?? [])
                    .filter((task) => !task.done && task.ticket?.system === "bsm")
                    .map((task) => task.ticket!.number),
            getSeen: () => getAgentStore().get("bsmSeen")?.[userId] ?? {},
            setSeen: (seen) => getAgentStore().set("bsmSeen", { ...getAgentStore().get("bsmSeen"), [userId]: seen }),
            getProjectFolder,
            saveTask: (input) => saveTicketTask(userId, input),
        });
        return { ok: true, data: result };
    } catch (e) {
        if (e instanceof BsmLoginError) return failure("not_connected", "Not logged in to BSM");
        console.error("Failed to import the tickets of BSM", e);
        return failure("unavailable", e instanceof Error ? e.message : String(e));
    } finally {
        api?.close();
    }
}

/**
 * Set the project folder of an application of BSM tickets, and give it to the open tasks of its tickets that have
 * none yet.
 * @returns the tasks that got the folder
 */
export function setBsmProjectFolder(userId: string, application: string, folder: string): AgentResult<AgentTask[]> {
    if (!application.trim() || !isDirectory(folder)) return failure("invalid_request");
    getAgentStore().set("bsmProjects", { ...getAgentStore().get("bsmProjects"), [application]: folder });
    const tasks = getAgentStore().get("tasks")?.[userId] ?? [];
    const changed = tasks
        .filter((task) => !task.done && !task.workspacePath && task.ticket?.application === application)
        .flatMap((task) => setAgentTaskWorkspace(userId, task.id, folder) ?? []);
    return { ok: true, data: changed };
}

/** Forget the login to BSM */
export async function logoutFromBsm(): Promise<void> {
    await getBsmSession().clearStorageData();
}
