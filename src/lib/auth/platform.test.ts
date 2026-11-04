import { beforeEach, describe, expect, it, vi } from "vitest";

let flag: { data: unknown; error: unknown } = { data: { can_create_workspaces: true }, error: null };

const { ForbiddenError } = vi.hoisted(() => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));
const requireRole = vi.fn();
vi.mock("@/lib/auth/account", () => ({
  ForbiddenError,
  requireRole: (...a: unknown[]) => requireRole(...a),
}));

import { requirePlatformAdmin } from "./platform";

beforeEach(() => {
  flag = { data: { can_create_workspaces: true }, error: null };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => flag,
  };
  requireRole.mockResolvedValue({ accountId: "a1", supabase: { from: () => chain } });
});

describe("requirePlatformAdmin", () => {
  it("allows the owner of the platform account", async () => {
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ accountId: "a1" });
    expect(requireRole).toHaveBeenCalledWith("owner");
  });

  it("refuses an owner whose account has no platform flag", async () => {
    flag = { data: { can_create_workspaces: false }, error: null };
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("fails closed when the flag cannot be read", async () => {
    flag = { data: null, error: { message: "no column" } };
    await expect(requirePlatformAdmin()).rejects.toBeInstanceOf(ForbiddenError);
  });
});
