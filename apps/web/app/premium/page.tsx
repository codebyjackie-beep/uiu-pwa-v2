import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { PremiumView } from "./PremiumView";

export const dynamic = "force-dynamic";

/** Milestone 3 — /premium: plan status, usage, and upgrade. Signed-in only (guests sign up first). */
export default async function PremiumPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=%2Fpremium");
  return <PremiumView />;
}
