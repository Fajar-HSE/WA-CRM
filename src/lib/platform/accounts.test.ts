import { describe, expect, it } from "vitest";
import { listPlatformAccounts } from "./accounts";

function admin(tables: Record<string, { data: unknown[] | null; error?: { message: string } }>) {
  return {
    from: (name: string) => {
      const res = tables[name] ?? { data: [] };
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => Promise.resolve({ data: res.data, error: res.error ?? null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({ data: res.data, error: res.error ?? null }).then(ok),
      };
      return chain;
    },
  } as never;
}

describe("listPlatformAccounts", () => {
  it("joins owner, member count and WhatsApp status per account", async () => {
    const rows = await listPlatformAccounts(
      admin({
        accounts: {
          data: [
            { id: "a1", name: "Platform", owner_user_id: "u1", created_at: "2026-01-01", disabled_at: null, can_create_workspaces: true },
            { id: "a2", name: "Budi", owner_user_id: "u2", created_at: "2026-02-01", disabled_at: "2026-03-01", can_create_workspaces: false },
          ],
        },
        profiles: {
          data: [
            { user_id: "u1", email: "a@x.id", full_name: "Admin", account_id: "a1" },
            { user_id: "u2", email: "b@x.id", full_name: "Budi", account_id: "a2" },
            { user_id: "u3", email: "c@x.id", full_name: "Citra", account_id: "a2" },
          ],
        },
        whatsapp_config: {
          data: [{ account_id: "a2", status: "connected", waha_session_status: "WORKING" }],
        },
      }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: "a1", isPlatform: true, memberCount: 1, whatsappStatus: null, ownerEmail: "a@x.id" });
    expect(rows[1]).toMatchObject({ id: "a2", isPlatform: false, memberCount: 2, whatsappStatus: "WORKING", disabledAt: "2026-03-01", ownerName: "Budi" });
  });

  it("throws when the accounts query fails", async () => {
    await expect(
      listPlatformAccounts(admin({ accounts: { data: null, error: { message: "boom" } } })),
    ).rejects.toThrow("boom");
  });
});
