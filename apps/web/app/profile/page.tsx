import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import type { UiuUser } from "@uiu/shared";
import { apiPost } from "../lib/api";
import { ProfileView } from "./ProfileView";

export const dynamic = "force-dynamic";

/** cc_prompt_meal_grid_profile.md Part P — /profile (reached from the header avatar). Signed-in only
 * (middleware gates it; the redirect is a belt-and-braces fallback). */
export default async function ProfilePage() {
  const { userId, getToken } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=%2Fprofile");

  const user = await currentUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || email.split("@")[0] || "You";

  // "Member since" prefers the users doc (survives the Clerk instance move — the remap keeps the old createdAt),
  // falling back to Clerk's own createdAt. /users/sync is get-or-create, the same call Home makes.
  let createdAt: string | number | null = user?.createdAt ?? null;
  if (email) {
    const token = await getToken();
    const res = await apiPost<UiuUser>("/api/users/sync", { clerkUserId: userId, email }, token ? { Authorization: `Bearer ${token}` } : undefined);
    if (res.ok && res.data.createdAt) createdAt = res.data.createdAt;
  }
  const memberSince = createdAt ? new Date(createdAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : null;

  return <ProfileView name={name} email={email} imageUrl={user?.hasImage ? user.imageUrl : null} memberSince={memberSince} />;
}
