import { NextResponse } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { apiPost } from "../../../lib/api";

/** B (pending list): get-or-create the `users` doc from any page after sign-in, not only Home — e.g. a guest who signs
 * up from a recipe and is sent straight back there. Idempotent on the API side (findOne-then-insert). */
export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ ok: false, error: { code: "unauthorized", message: "Not signed in" } }, { status: 401 });
  const email = (await currentUser())?.primaryEmailAddress?.emailAddress ?? "";
  if (!email) return NextResponse.json({ ok: false, error: { code: "no_email", message: "No primary email" } });
  return NextResponse.json(await apiPost("/api/users/sync", { clerkUserId: userId, email }));
}
