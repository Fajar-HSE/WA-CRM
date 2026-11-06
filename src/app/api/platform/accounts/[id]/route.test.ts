import { beforeEach, describe, expect, it, vi } from "vitest";

const updates: Record<string, unknown>[] = [];
let target: { id: string; can_create_workspaces: boolean } | null;
let cfg: { provider: string; waha_session_name: string } | null;
const stopSession = vi.fn();

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
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          return chain;
        },
        maybeSingle: async () => ({
          data: table === "accounts" ? target : cfg,
          error: null,
        }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      };
      return chain;
    },
  }),
}));

import { PATCH } from "./route";

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

beforeEach(() => {
  updates.length = 0;
  stopSession.mockReset();
  process.env.WAHA_BASE_URL = "http://waha";
  process.env.WAHA_API_KEY = "k";
  requirePlatformAdmin.mockResolvedValue({ accountId: "platform-acct" });
  target = { id: ID, can_create_workspaces: false };
  cfg = { provider: "waha", waha_session_name: "wacrm-abc" };
});

describe("PATCH /api/platform/accounts/[id]", () => {
  it("disables an account and stops its WAHA session", async () => {
    const res = await call(ID, { disabled: true });
    expect(res.status).toBe(200);
    expect(updates[0].disabled_at).toEqual(expect.any(String));
    expect(stopSession).toHaveBeenCalledWith("wacrm-abc");
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
