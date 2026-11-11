import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: Record<string, unknown>[] = [];
const deletes: { table: string; eq: [string, unknown] | null }[] = [];
let target: { id: string; can_create_workspaces: boolean } | null;
let cfg: { provider: string; waha_session_name: string } | null;
const stopSession = vi.fn();
const deleteUser = vi.fn();

interface FakeScript {
  /** profiles rows returned for `eq("account_id", …)` selects. */
  profilesByAccount: Record<string, { user_id: string }[]>;
  /** accounts rows returned for `eq("owner_user_id", …)` selects. */
  ownedByUser: Record<string, { id: string }[]>;
  /** Error to return from an accounts DELETE, if any. */
  deleteAccountError: { message: string } | null;
}
const script: FakeScript = {
  profilesByAccount: {},
  ownedByUser: {},
  deleteAccountError: null,
};

vi.mock("@/lib/auth/account", () => ({
  toErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: String(e) }), { status: 403 }),
}));
const requirePlatformAdmin = vi.fn();
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: () => requirePlatformAdmin(),
}));
vi.mock("@/lib/whatsapp/providers/waha", () => ({
  WahaWhatsAppProvider: class {
    stopSession = stopSession;
  },
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    auth: {
      admin: {
        deleteUser: (...a: unknown[]) => Promise.resolve(deleteUser(...a)),
      },
    },
    from: (table: string) => {
      const state: {
        action: string;
        values?: Record<string, unknown>;
        eqCol: string | null;
        eqVal: unknown;
      } = { action: "select", eqCol: null, eqVal: null };
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (row: Record<string, unknown>) => {
          state.action = "update";
          state.values = row;
          updates.push(row);
          return chain;
        },
        delete: () => {
          state.action = "delete";
          return chain;
        },
        eq: (col: string, val: unknown) => {
          state.eqCol = col;
          state.eqVal = val;
          return chain;
        },
        is: () => chain,
        gt: () => chain,
        maybeSingle: async () => ({
          data: table === "accounts" ? target : cfg,
          error: null,
        }),
        then: (ok: (v: unknown) => unknown) => {
          if (
            table === "accounts" &&
            state.action === "delete" &&
            script.deleteAccountError
          ) {
            deletes.push({ table, eq: [state.eqCol ?? "", state.eqVal] });
            return Promise.resolve({ data: null, error: script.deleteAccountError }).then(ok);
          }
          if (table === "profiles" && state.action === "select") {
            return Promise.resolve({
              data: script.profilesByAccount[state.eqVal as string] ?? [],
              error: null,
            }).then(ok);
          }
          if (table === "accounts" && state.action === "select") {
            return Promise.resolve({
              data: script.ownedByUser[state.eqVal as string] ?? [],
              error: null,
            }).then(ok);
          }
          if (table === "accounts" && state.action === "delete") {
            deletes.push({ table, eq: [state.eqCol ?? "", state.eqVal] });
          }
          return Promise.resolve({ data: null, error: null }).then(ok);
        },
      };
      return chain;
    },
  }),
}));

import { DELETE, PATCH } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";
function call(id: string, body: unknown) {
  return PATCH(
    new Request("https://crm.example.com/api/platform/accounts/x", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}
function callDelete(id: string) {
  return DELETE(
    new Request("https://crm.example.com/api/platform/accounts/x", { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
}

beforeEach(() => {
  updates.length = 0;
  deletes.length = 0;
  stopSession.mockReset();
  deleteUser.mockReset();
  deleteUser.mockResolvedValue({ error: null });
  script.profilesByAccount = {};
  script.ownedByUser = {};
  script.deleteAccountError = null;
  process.env.WAHA_BASE_URL = "http://waha";
  process.env.WAHA_API_KEY = "k";
  requirePlatformAdmin.mockResolvedValue({ accountId: "platform-acct", userId: "admin-user" });
  target = { id: ID, can_create_workspaces: false };
  cfg = { provider: "waha", waha_session_name: "wa-crm-abc" };
});

describe("PATCH /api/platform/accounts/[id]", () => {
  it("disables an account and stops its WAHA session", async () => {
    const res = await call(ID, { disabled: true });
    expect(res.status).toBe(200);
    expect(updates[0].disabled_at).toEqual(expect.any(String));
    expect(stopSession).toHaveBeenCalledWith("wa-crm-abc");
    expect((await res.json()).sessionStopped).toBe(true);
  });

  it("still disables when WAHA is unreachable", async () => {
    stopSession.mockRejectedValue(new Error("down"));
    const res = await call(ID, { disabled: true });
    expect(res.status).toBe(200);
    expect((await res.json()).sessionStopped).toBe(false);
  });

  it("enables an account by clearing the flag", async () => {
    const res = await call(ID, { disabled: false });
    expect(res.status).toBe(200);
    expect(updates[0]).toEqual({ disabled_at: null });
    expect(stopSession).not.toHaveBeenCalled();
  });

  it("refuses to disable the caller's own account", async () => {
    requirePlatformAdmin.mockResolvedValue({ accountId: ID });
    expect((await call(ID, { disabled: true })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("refuses to disable another platform account", async () => {
    target = { id: ID, can_create_workspaces: true };
    expect((await call(ID, { disabled: true })).status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it("rejects a bad id, a bad body and an unknown account", async () => {
    expect((await call("nope", { disabled: true })).status).toBe(404);
    expect((await call(ID, { disabled: "yes" })).status).toBe(400);
    target = null;
    expect((await call(ID, { disabled: true })).status).toBe(404);
  });

  it("does nothing for a non-platform caller", async () => {
    requirePlatformAdmin.mockRejectedValue(new Error("Forbidden"));
    expect((await call(ID, { disabled: true })).status).toBe(403);
    expect(updates).toHaveLength(0);
  });
});

describe("DELETE /api/platform/accounts/[id]", () => {
  const OWNER = "user-owner";
  const MEMBER = "user-member";

  it("deletes the account and every member's login", async () => {
    script.profilesByAccount[ID] = [{ user_id: OWNER }, { user_id: MEMBER }];

    const res = await callDelete(ID);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deletedUsers).toBe(2);
    expect(json.failed).toEqual([]);
    expect(json.sessionStopped).toBe(true);
    expect(stopSession).toHaveBeenCalledWith("wa-crm-abc");

    // Account row gone (its data cascades in Postgres).
    expect(deletes.some((d) => d.table === "accounts" && d.eq?.[1] === ID)).toBe(true);
    // Both logins removed from auth.users.
    expect(deleteUser).toHaveBeenCalledWith(OWNER);
    expect(deleteUser).toHaveBeenCalledWith(MEMBER);
  });

  it("works without a WAHA session", async () => {
    cfg = null;
    script.profilesByAccount[ID] = [{ user_id: OWNER }];
    const res = await callDelete(ID);
    expect(res.status).toBe(200);
    expect((await res.json()).sessionStopped).toBe(false);
    expect(deleteUser).toHaveBeenCalledWith(OWNER);
  });

  it("deletes accounts the victim owns, but refuses when outsiders are members", async () => {
    script.profilesByAccount[ID] = [{ user_id: OWNER }];
    script.ownedByUser[OWNER] = [{ id: "other-acct" }];
    script.profilesByAccount["other-acct"] = [{ user_id: OWNER }];

    let res = await callDelete(ID);
    expect(res.status).toBe(200);
    expect((await res.json()).deletedUsers).toBe(1);
    expect(deletes.some((d) => d.table === "accounts" && d.eq?.[1] === "other-acct")).toBe(true);
    expect(deleteUser).toHaveBeenCalledWith(OWNER);

    // Same shape, but the owned account still has a member who is NOT
    // part of this delete → the owned account and the login stay put,
    // and the failure is reported instead of silently half-deleting.
    deletes.length = 0;
    deleteUser.mockClear();
    script.profilesByAccount[ID] = [{ user_id: OWNER }];
    script.ownedByUser[OWNER] = [{ id: "shared-acct" }];
    script.profilesByAccount["shared-acct"] = [
      { user_id: OWNER },
      { user_id: "outsider" },
    ];

    res = await callDelete(ID);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.deletedUsers).toBe(0);
    expect(json.failed).toHaveLength(1);
    expect(json.failed[0].userId).toBe(OWNER);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("reports a failed login deletion instead of swallowing it", async () => {
    script.profilesByAccount[ID] = [{ user_id: OWNER }];
    deleteUser.mockResolvedValue({ error: { message: "auth is down" } });
    const res = await callDelete(ID);
    const json = await res.json();
    expect(json.deletedUsers).toBe(0);
    expect(json.failed[0]).toEqual({ userId: OWNER, error: "auth is down" });
  });

  it("refuses the caller's own account, the platform account, bad ids and non-admins", async () => {
    requirePlatformAdmin.mockResolvedValue({ accountId: ID, userId: "admin-user" });
    expect((await callDelete(ID)).status).toBe(400);

    target = { id: ID, can_create_workspaces: true };
    expect((await callDelete(ID)).status).toBe(400);

    expect((await callDelete("nope")).status).toBe(404);
    target = null;
    requirePlatformAdmin.mockResolvedValue({ accountId: "platform-acct", userId: "admin-user" });
    expect((await callDelete(ID)).status).toBe(404);

    requirePlatformAdmin.mockRejectedValue(new Error("Forbidden"));
    expect((await callDelete(ID)).status).toBe(403);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
