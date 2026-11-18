/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// Imports the bug tickets of BSM, the Boom Support Manager, that are not closed into the user's to-do list, so that
// the agent can look into them in the project folder of the customer's application. BSM has no API for other
// programs: the user logs in once in a window of the app, in a session of its own that is kept, and the app reads the
// ticket list page and the ticket pages with that session. The app never sees the password.

import { BrowserWindow, session } from "electron";
import type { AgentResult, AgentTask, AgentTicketRef } from "shared-types";

import { failure, getAgentStore, isDirectory } from "./agent.js";
import { saveTicketTask, setAgentTaskWorkspace, type TicketTaskInput } from "./agent-tasks.js";

/** The address of BSM */
export const BSM_URL = "https://bsm.boomsoftware.com";

/** The session the user is logged in to BSM with; `persist:` keeps it after the app closes */
const BSM_PARTITION = "persist:agent-bsm";

/** How long to wait for the ticket list to show */
const LIST_TIMEOUT_MS = 30 * 1000;

/** The states of a ticket that count as closed; the others, such as `inprocess` or `delivered`, are still open */
const CLOSED_STATES = new Set(["completed", "closed", "rejected", "cancelled", "canceled"]);

/** The main category of the tickets that report a bug; only these are imported */
const BUG_CATEGORY = "Fehlermeldung";

/** How much of a comment the task shows */
const MAX_COMMENT_LENGTH = 600;

/** A row of the ticket list of BSM */
export interface BsmListRow {
    number: string;
    category: string;
    summary: string;
    /** When it last changed, as the list shows it, such as `05.11.2026 14:21` */
    changedAt: string;
}

/** A ticket as the ticket page of BSM returns it, with the fields used here */
export interface BsmTicket {
    Indication?: {
        Number?: string;
        Link?: string;
        ApplicationName?: string;
        ProjectName?: string;
        Summary?: string;
        Description?: string;
        MainCategoryName?: string;
        CategoryName?: string;
        Status?: string;
        InstallationName?: string;
        Reporter?: string;
        Handler?: string;
        Conversations?: {
            Name?: string;
            Comments?: { CreateDate?: string; CreateBy?: string; CommentText?: string }[];
        }[];
    };
    Users?: { Username?: string; Name?: string }[];
}

/** What the import needs from the app, so that it can be tested without one */
export interface BsmImportDeps {
    readList(): Promise<BsmListRow[]>;
    readTicket(number: string): Promise<BsmTicket>;
    /** When each ticket last changed, as the list showed it at the last import */
    getSeen(): Record<string, string>;
    setSeen(seen: Record<string, string>): void;
    /** The project folder of an application, if the user set one */
    getProjectFolder(application: string): string | undefined;
    saveTask(input: TicketTaskInput): { task: AgentTask; added: boolean } | undefined;
}

/** What an import did */
export interface BsmImportResult {
    /** How many tickets the list showed */
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

/** Whether a ticket reports a bug, rather than asking a question or for a change */
export function isBugTicket(ticket: BsmTicket): boolean {
    return ticket.Indication?.MainCategoryName?.trim().toLowerCase() === BUG_CATEGORY.toLowerCase();
}

/** Turn a ticket of BSM into the text of a task: what is asked, and the conversations about it, oldest first */
export function describeTicket(ticket: BsmTicket): string {
    const t = ticket.Indication ?? {};
    const names = new Map((ticket.Users ?? []).map((user) => [user.Username ?? "", user.Name ?? user.Username ?? ""]));
    const name = (username: string | undefined): string => names.get(username ?? "") || username || "?";
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
        const comments = [...(conversation.Comments ?? [])].sort((a, b) =>
            (a.CreateDate ?? "").localeCompare(b.CreateDate ?? ""),
        );
        if (comments.length === 0) continue;
        lines.push("", `Conversation "${conversation.Name ?? ""}":`);
        for (const comment of comments) {
            const text = (comment.CommentText ?? "").trim().replace(/\s+\n/g, "\n").slice(0, MAX_COMMENT_LENGTH);
            lines.push(`- ${(comment.CreateDate ?? "").slice(0, 10)} ${name(comment.CreateBy)}: ${text}`);
        }
    }
    return lines.join("\n");
}

/** The reference of the task to a ticket of BSM */
export function toTicketRef(ticket: BsmTicket, row: BsmListRow): AgentTicketRef {
    const t = ticket.Indication ?? {};
    return {
        system: "bsm",
        number: row.number,
        url: t.Link ?? `${BSM_URL}/indication/${row.number}`,
        application: t.ApplicationName,
        status: t.Status,
        changedAt: row.changedAt,
    };
}

/**
 * Read the ticket list of BSM, and add the bug tickets that are not closed and are new or changed since the last
 * import to the to-do list. The task of a ticket that was closed in BSM is marked as done. Questions and requests
 * for changes are left out.
 */
export async function importBsmTickets(deps: BsmImportDeps): Promise<BsmImportResult> {
    const rows = await deps.readList();
    const seen = { ...deps.getSeen() };
    const result: BsmImportResult = {
        listed: rows.length,
        added: [],
        updated: [],
        closed: [],
        withoutFolder: [],
        errors: [],
    };
    const withoutFolder = new Set<string>();
    for (const row of rows) {
        if (seen[row.number] === row.changedAt) continue;
        let ticket: BsmTicket;
        try {
            ticket = await deps.readTicket(row.number);
        } catch (e) {
            if (e instanceof BsmLoginError) throw e;
            result.errors.push(`${row.number}: ${e instanceof Error ? e.message : String(e)}`);
            continue;
        }
        if (!isBugTicket(ticket)) {
            seen[row.number] = row.changedAt;
            continue;
        }
        const ref = toTicketRef(ticket, row);
        const closed = !isOpenState(ref.status);
        const folder = ref.application ? deps.getProjectFolder(ref.application) : undefined;
        const saved = deps.saveTask({
            ticket: ref,
            title: `${row.number}: ${ticket.Indication?.Summary || row.summary}`,
            details: describeTicket(ticket),
            workspacePath: folder,
            closed,
        });
        seen[row.number] = row.changedAt;
        if (!saved) continue;
        if (closed) result.closed.push(saved.task);
        else (saved.added ? result.added : result.updated).push(saved.task);
        if (!closed && !saved.task.workspacePath && ref.application) withoutFolder.add(ref.application);
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

/** A hidden window in the session of BSM, to read its pages */
function createReader(): BrowserWindow {
    getBsmSession();
    const win = new BrowserWindow({
        show: false,
        webPreferences: { partition: BSM_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    keepInWindow(win);
    return win;
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

/** The script that reads the rows of the ticket list page, or null while the list hasn't shown yet */
const READ_LIST_SCRIPT = `(() => {
    const rows = [...document.querySelectorAll("tr")].filter((tr) => tr.querySelector('a[href^="indication/"]'));
    if (rows.length === 0) return document.body.innerText.includes("Suchergebnis") ? [] : null;
    return rows.map((tr) => {
        const cells = [...tr.cells].map((cell) => cell.innerText.trim());
        return { number: cells[2], category: cells[3], summary: cells[4], changedAt: cells[5] };
    });
})()`;

async function readList(): Promise<BsmListRow[]> {
    const win = createReader();
    try {
        console.log("BSM: reading the ticket list");
        await load(win, `${BSM_URL}/#Indications`);
        const until = Date.now() + LIST_TIMEOUT_MS;
        while (Date.now() < until) {
            if (isLoginPage(win.webContents.getURL())) {
                console.log(`BSM: not logged in, the list page went to ${new URL(win.webContents.getURL()).host}`);
                throw new BsmLoginError();
            }
            const rows = (await win.webContents.executeJavaScript(READ_LIST_SCRIPT).catch(() => null)) as
                | BsmListRow[]
                | null;
            if (rows) {
                console.log(`BSM: the list shows ${rows.length} tickets`);
                return rows.filter((row) => row.number);
            }
            await sleep(500);
        }
        throw new Error("The ticket list of BSM did not show");
    } finally {
        win.destroy();
    }
}

async function readTicketWith(win: BrowserWindow, number: string): Promise<BsmTicket> {
    if (!/^[\w.-]+$/.test(number)) throw new Error(`not a ticket number: ${number}`);
    await load(win, `${BSM_URL}/personal/api/indication/${encodeURIComponent(number)}`);
    // Without a login, the page sends the browser to the login with a script
    await sleep(300);
    if (isLoginPage(win.webContents.getURL())) throw new BsmLoginError();
    const text = (await win.webContents.executeJavaScript("document.body.innerText")) as string;
    try {
        return JSON.parse(text) as BsmTicket;
    } catch {
        if (isLoginPage(win.webContents.getURL())) throw new BsmLoginError();
        throw new Error(`BSM did not answer with a ticket: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
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
 * Import the open tickets of BSM into the to-do list of a user.
 */
export async function importBsmTicketsForUser(userId: string): Promise<AgentResult<BsmImportResult>> {
    const reader = createReader();
    try {
        const result = await importBsmTickets({
            readList,
            readTicket: (number) => readTicketWith(reader, number),
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
        reader.destroy();
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
