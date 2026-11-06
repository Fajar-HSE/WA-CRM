import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { listPlatformAccounts } from "@/lib/platform/accounts";

/** Every account on this installation. Platform administrator only. */
export async function GET() {
  try {
    await requirePlatformAdmin();
    const accounts = await listPlatformAccounts(supabaseAdmin());
    return NextResponse.json({ accounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
