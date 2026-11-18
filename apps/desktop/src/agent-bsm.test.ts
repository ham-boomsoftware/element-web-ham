/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "shared-types";

import {
    BsmLoginError,
    type BsmImportDeps,
    type BsmIndication,
    type BsmUser,
    buildOpenBugsQuery,
    describeTicket,
    importBsmTickets,
    isLoginPage,
    isOpenState,
} from "./agent-bsm.js";

vi.mock("electron", () => ({ BrowserWindow: vi.fn(), session: {} }));
vi.mock("./agent.js", () => ({
    failure: (error: string) => ({ ok: false, error }),
    getAgentStore: vi.fn(),
    isDirectory: vi.fn(),
}));
vi.mock("./agent-tasks.js", () => ({ saveTicketTask: vi.fn(), setAgentTaskWorkspace: vi.fn() }));

const USERS: BsmUser[] = [
    { Username: "HIR", Name: "Hirzer Christiane" },
    { Username: "j.janssen@ell.co.at", Name: "Janek Janßen" },
];

function bug(number: string, changes: Partial<BsmIndication> = {}): BsmIndication {
    return {
        Number: number,
        Link: `https://bsm.example/indication/${number}`,
        ApplicationName: "ELL BRS",
        Summary: `Summary of ${number}`,
        Description: "Spalte ausblenden",
        MainCategoryName: "Fehlermeldung",
        CategoryName: "Fehler, Workaround möglich",
        Status: "inprocess",
        ChangeDate: "2026-11-05T14:21:00Z",
        Reporter: "j.janssen@ell.co.at",
        Handler: "HIR",
        Conversations: [
            {
                Name: "ad 1)",
                Comments: [
                    {
                        CreateDate: "2026-11-17T07:12:34Z",
                        CreateBy: "HIR",
                        CommentText: "Im PROD erledigt",
                        ChildComments: [
                            { CreateDate: "2026-11-18T07:00:00Z", CreateBy: "HIR", CommentText: "Nachtrag" },
                        ],
                    },
                    { CreateDate: "2026-11-16T08:11:29Z", CreateBy: "d.vasiu@ell.co.at", CommentText: "1 ist OK" },
                    { CreateDate: "2026-11-16T09:00:00Z", CreateBy: "HIR", CommentText: null },
                ],
            },
        ],
        ...changes,
    };
}

function task(id: string, changes: Partial<AgentTask> = {}): AgentTask {
    return { id, title: id, details: "", done: false, createdAt: 1, ...changes };
}

describe("isLoginPage", () => {
    it("counts pages outside of BSM and the OAuth start as the login", () => {
        expect(isLoginPage("https://auth.boomsoftware.com/auth/realms/master/protocol/openid-connect/auth")).toBe(true);
        expect(isLoginPage("https://login.microsoftonline.com/common/oauth2")).toBe(true);
        expect(isLoginPage("https://bsm.boomsoftware.com/x?LoginOAuth=1&provider=boombsm")).toBe(true);
        expect(isLoginPage("https://bsm.boomsoftware.com/#Indications")).toBe(false);
        expect(isLoginPage("not a url")).toBe(false);
    });
});

describe("isOpenState", () => {
    it("counts every ticket that is not closed as open, also a delivered fix", () => {
        expect(isOpenState("new")).toBe(true);
        expect(isOpenState("InProcess")).toBe(true);
        expect(isOpenState("delivered")).toBe(true);
        expect(isOpenState("completed")).toBe(false);
        expect(isOpenState("archived")).toBe(false);
        expect(isOpenState(undefined)).toBe(false);
    });
});

describe("buildOpenBugsQuery", () => {
    it("asks for the bugs that are not closed, with descriptions and conversations", () => {
        expect(buildOpenBugsQuery(500)).toEqual({
            filter: { mainCategoryFilter: "ErrorMessage", statusFilter: ["new", "inprocess", "delivered"] },
            details: { includeLink: true, includeDescription: true, includeConversations: true },
            limit: 500,
            offset: 500,
        });
    });
});

describe("describeTicket", () => {
    it("tells what is asked, with the comments and replies oldest first and the names of the people", () => {
        const text = describeTicket(bug("ELLBg0169"), USERS);

        expect(text).toContain("BSM ticket ELLBg0169: Summary of ELLBg0169");
        expect(text).toContain("https://bsm.example/indication/ELLBg0169");
        expect(text).toContain("Application: ELL BRS");
        expect(text).toContain("Fehlermeldung / Fehler, Workaround möglich");
        expect(text).toContain("Reporter: Janek Janßen · Handler: Hirzer Christiane");
        expect(text).toContain("Spalte ausblenden");
        expect(text.indexOf("1 ist OK")).toBeLessThan(text.indexOf("Im PROD erledigt"));
        expect(text).toContain("- 2026-11-18 Hirzer Christiane: Nachtrag");
        expect(text).not.toContain("null");
    });
});

describe("importBsmTickets", () => {
    let deps: BsmImportDeps & { [K in keyof BsmImportDeps]: ReturnType<typeof vi.fn> };
    let seen: Record<string, string>;

    beforeEach(() => {
        seen = {};
        deps = {
            queryOpenBugs: vi.fn(async () => ({ indications: [bug("ELLBg0169"), bug("ELLBg0172")], users: USERS })),
            readTicket: vi.fn(),
            getOpenTicketNumbers: vi.fn(() => []),
            getSeen: vi.fn(() => seen),
            setSeen: vi.fn((next) => (seen = next)),
            getProjectFolder: vi.fn(() => undefined),
            saveTask: vi.fn((input) => ({
                task: task(input.ticket.number, { workspacePath: input.workspacePath, done: input.closed }),
                added: true,
            })),
        } as never;
    });

    it("adds the open bugs with their ticket", async () => {
        const result = await importBsmTickets(deps);

        expect(result.listed).toBe(2);
        expect(result.added.map((t) => t.id)).toEqual(["ELLBg0169", "ELLBg0172"]);
        expect(deps.saveTask).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "ELLBg0169: Summary of ELLBg0169",
                closed: false,
                ticket: expect.objectContaining({
                    system: "bsm",
                    number: "ELLBg0169",
                    application: "ELL BRS",
                    status: "inprocess",
                }),
            }),
        );
        expect(seen).toEqual({ ELLBg0169: "2026-11-05T14:21:00Z", ELLBg0172: "2026-11-05T14:21:00Z" });
    });

    it("skips the tickets that did not change since the last import", async () => {
        seen = { ELLBg0169: "2026-11-05T14:21:00Z", ELLBg0172: "2026-11-05T14:21:00Z" };

        const result = await importBsmTickets(deps);

        expect(deps.saveTask).not.toHaveBeenCalled();
        expect(result.added).toEqual([]);
    });

    it("marks the task of a ticket closed in BSM as done", async () => {
        deps.getOpenTicketNumbers.mockReturnValue(["ELLBg0169", "ELLBg0150"]);
        deps.readTicket.mockResolvedValue({ Indication: bug("ELLBg0150", { Status: "completed" }), Users: USERS });
        seen = { ELLBg0150: "2026-11-01T00:00:00Z" };

        const result = await importBsmTickets(deps);

        expect(deps.readTicket).toHaveBeenCalledWith("ELLBg0150");
        expect(deps.readTicket).not.toHaveBeenCalledWith("ELLBg0169");
        expect(deps.saveTask).toHaveBeenCalledWith(expect.objectContaining({ closed: true }));
        expect(result.closed.map((t) => t.id)).toEqual(["ELLBg0150"]);
        expect(seen.ELLBg0150).toBeUndefined();
    });

    it("leaves a task open whose ticket is still open, but no longer a bug the query returns", async () => {
        deps.getOpenTicketNumbers.mockReturnValue(["ELLBg0150"]);
        deps.readTicket.mockResolvedValue({ Indication: bug("ELLBg0150", { Status: "inprocess" }) });

        const result = await importBsmTickets(deps);

        expect(result.closed).toEqual([]);
    });

    it("gives the task the project folder of its application, or names the application without one", async () => {
        const withFolder = await importBsmTickets({ ...deps, getProjectFolder: () => "C:\\ell" });
        expect(deps.saveTask).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "C:\\ell" }));
        expect(withFolder.withoutFolder).toEqual([]);

        seen = {};
        const without = await importBsmTickets(deps);
        expect(without.withoutFolder).toEqual(["ELL BRS"]);
    });

    it("goes on when a closed ticket can't be read", async () => {
        deps.getOpenTicketNumbers.mockReturnValue(["ELLBg0150"]);
        deps.readTicket.mockRejectedValue(new Error("BSM answered 404"));

        const result = await importBsmTickets(deps);

        expect(result.errors).toEqual(["ELLBg0150: BSM answered 404"]);
    });

    it("stops when the user is not logged in", async () => {
        deps.queryOpenBugs.mockRejectedValue(new BsmLoginError());

        await expect(importBsmTickets(deps)).rejects.toBeInstanceOf(BsmLoginError);
        expect(deps.setSeen).not.toHaveBeenCalled();
    });
});
