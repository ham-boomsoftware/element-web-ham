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
    type BsmListRow,
    type BsmTicket,
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

function row(number: string, changedAt = "05.11.2026 14:21"): BsmListRow {
    return { number, category: "Analyse", summary: `Summary of ${number}`, changedAt };
}

function ticket(number: string, status = "inprocess", application = "ELL BRS"): BsmTicket {
    return {
        Indication: {
            Number: number,
            Link: `https://bsm.example/indication/${number}`,
            ApplicationName: application,
            Summary: `Summary of ${number}`,
            Description: "Spalte ausblenden",
            Status: status,
            Reporter: "j.janssen@ell.co.at",
            Handler: "HIR",
            Conversations: [
                {
                    Name: "ad 1)",
                    Comments: [
                        { CreateDate: "2026-11-17T07:12:34Z", CreateBy: "HIR", CommentText: "Im PROD erledigt" },
                        { CreateDate: "2026-11-16T08:11:29Z", CreateBy: "d.vasiu@ell.co.at", CommentText: "1 ist OK" },
                    ],
                },
            ],
        },
        Users: [
            { Username: "HIR", Name: "Hirzer Christiane" },
            { Username: "j.janssen@ell.co.at", Name: "Janek Janßen" },
        ],
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
    it("counts new and in process tickets as open", () => {
        expect(isOpenState("new")).toBe(true);
        expect(isOpenState("InProcess")).toBe(true);
        expect(isOpenState("completed")).toBe(false);
        expect(isOpenState("delivered")).toBe(false);
        expect(isOpenState(undefined)).toBe(false);
    });
});

describe("describeTicket", () => {
    it("tells what is asked, with the comments oldest first and the names of the people", () => {
        const text = describeTicket(ticket("ELLBg0169"));

        expect(text).toContain("BSM ticket ELLBg0169: Summary of ELLBg0169");
        expect(text).toContain("https://bsm.example/indication/ELLBg0169");
        expect(text).toContain("Application: ELL BRS");
        expect(text).toContain("Reporter: Janek Janßen · Handler: Hirzer Christiane");
        expect(text).toContain("Spalte ausblenden");
        expect(text.indexOf("1 ist OK")).toBeLessThan(text.indexOf("Im PROD erledigt"));
        expect(text).toContain("- 2026-11-17 Hirzer Christiane: Im PROD erledigt");
    });
});

describe("importBsmTickets", () => {
    let deps: BsmImportDeps & { [K in keyof BsmImportDeps]: ReturnType<typeof vi.fn> };
    let seen: Record<string, string>;

    beforeEach(() => {
        seen = {};
        deps = {
            readList: vi.fn(async () => [row("ELLBg0169"), row("ELLBg0170")]),
            readTicket: vi.fn(async (number: string) => ticket(number, number === "ELLBg0170" ? "completed" : "new")),
            getSeen: vi.fn(() => seen),
            setSeen: vi.fn((next) => (seen = next)),
            getProjectFolder: vi.fn(() => undefined),
            saveTask: vi.fn((input) =>
                input.closed
                    ? undefined
                    : { task: task(input.ticket.number, { workspacePath: input.workspacePath }), added: true },
            ),
        } as never;
    });

    it("adds the open tickets and leaves out closed ones that are not on the list", async () => {
        const result = await importBsmTickets(deps);

        expect(result.listed).toBe(2);
        expect(result.added.map((t) => t.id)).toEqual(["ELLBg0169"]);
        expect(result.closed).toEqual([]);
        expect(deps.saveTask).toHaveBeenCalledWith(
            expect.objectContaining({
                title: "ELLBg0169: Summary of ELLBg0169",
                closed: false,
                ticket: expect.objectContaining({ system: "bsm", number: "ELLBg0169", application: "ELL BRS" }),
            }),
        );
        expect(seen).toEqual({ ELLBg0169: "05.11.2026 14:21", ELLBg0170: "05.11.2026 14:21" });
    });

    it("skips the tickets that did not change since the last import", async () => {
        seen = { ELLBg0169: "05.11.2026 14:21", ELLBg0170: "05.11.2026 14:21" };

        const result = await importBsmTickets(deps);

        expect(deps.readTicket).not.toHaveBeenCalled();
        expect(result.added).toEqual([]);
    });

    it("marks the task of a ticket closed in BSM as done", async () => {
        deps.readList.mockResolvedValue([row("ELLBg0170", "18.11.2026 08:00")]);
        deps.saveTask.mockReturnValue({ task: task("ELLBg0170", { done: true }), added: false });

        const result = await importBsmTickets(deps);

        expect(deps.saveTask).toHaveBeenCalledWith(expect.objectContaining({ closed: true }));
        expect(result.closed.map((t) => t.id)).toEqual(["ELLBg0170"]);
    });

    it("gives the task the project folder of its application, or names the application without one", async () => {
        const withFolder = await importBsmTickets({ ...deps, getProjectFolder: () => "C:\\ell" });
        expect(deps.saveTask).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "C:\\ell" }));
        expect(withFolder.withoutFolder).toEqual([]);

        seen = {};
        const without = await importBsmTickets(deps);
        expect(without.withoutFolder).toEqual(["ELL BRS"]);
    });

    it("goes on when a ticket can't be read, and reads it again next time", async () => {
        deps.readTicket.mockRejectedValueOnce(new Error("timeout"));

        const result = await importBsmTickets(deps);

        expect(result.errors).toEqual(["ELLBg0169: timeout"]);
        expect(seen.ELLBg0169).toBeUndefined();
    });

    it("stops when the user is not logged in", async () => {
        deps.readTicket.mockRejectedValue(new BsmLoginError());

        await expect(importBsmTickets(deps)).rejects.toBeInstanceOf(BsmLoginError);
        expect(deps.setSeen).not.toHaveBeenCalled();
    });
});
