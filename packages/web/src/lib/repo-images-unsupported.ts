import "server-only";
import { NextResponse } from "next/server";
import { REPO_IMAGES_UNSUPPORTED_MESSAGE, supportsRepoImages } from "./sandbox-provider";
import { getServerAuthSession } from "./server-auth-session";

/** Authenticate only when rejecting locally, before disclosing provider support. */
export async function rejectUnsupportedRepoImages(): Promise<NextResponse | null> {
  if (supportsRepoImages()) return null;

  const session = await getServerAuthSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ error: REPO_IMAGES_UNSUPPORTED_MESSAGE }, { status: 501 });
}
