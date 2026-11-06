"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ApiResponse, MyPlan } from "@uiu/shared";
import { useClerk, useReverification, useUser } from "@clerk/nextjs";
import { isReverificationCancelledError } from "@clerk/nextjs/errors";
import { useInstallPrompt } from "../lib/useInstallPrompt";

const PREMIUM_FEATURES = ["AI Nutrition Coach", "AI meal plan wizard", "Barcode scan", "Fridge photo & receipt scan"];

export function ProfileView({ name, email, imageUrl, memberSince }: { name: string; email: string; imageUrl: string | null; memberSince: string | null }) {
  const { openUserProfile, signOut } = useClerk();
  const { canInstall, promptInstall } = useInstallPrompt();
  const [signingOut, setSigningOut] = useState(false);
  const [plan, setPlan] = useState<MyPlan | null>(null);
  const { user } = useUser();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const closeDelete = () => {
    if (deleting) return;
    setDeleteOpen(false);
    setDeleteText("");
    setDeleteError(null);
  };
  // Clerk deletes the account; its user.deleted webhook (apps/api routes/clerkWebhook.ts) then erases our data
  // and cancels any Stripe subscription. Needs "Allow users to delete their account" on for this user in Clerk.
  // Clerk treats delete as a sensitive action (sign-in / reverification within 10 min), so wrap it in
  // useReverification: it shows Clerk's verify modal when needed, then retries the delete.
  const deleteUser = useReverification(() => user!.delete());
  const deleteAccount = async () => {
    if (!user || deleteText.trim() !== "DELETE") return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteUser();
      window.location.assign("/how-it-works");
    } catch (err) {
      setDeleting(false);
      if (isReverificationCancelledError(err)) return; // user closed the verify modal — nothing to report
      const code = (err as { errors?: { code?: string }[] })?.errors?.[0]?.code ?? (err as { code?: string })?.code ?? "unknown";
      console.error("[uiu] delete account failed:", code);
      setDeleteError("We couldn't delete your account. Please try again, or email useitup.uk@gmail.com and we'll do it for you.");
    }
  };
  useEffect(() => {
    fetch("/api/me/plan", { cache: "no-store" })
      .then((r) => r.json() as Promise<ApiResponse<MyPlan>>)
      .then((j) => {
        if (j.ok) setPlan(j.data);
      })
      .catch(() => {});
  }, []);
  const isPremium = plan?.plan === "premium";
  const isTrial = plan?.plan === "trial";
  const trialDays = plan?.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(plan.trialEndsAt) - Date.now()) / 86_400_000)) : null;
  // Until /api/me/plan answers, say nothing about the plan — a paying user must not see "Free plan" flash up.
  const planTitle = !plan ? "Your plan" : isPremium ? "Premium" : isTrial ? "Free trial" : "Free plan";
  const initial = (name.trim()[0] ?? "?").toUpperCase();

  return (
    <div className="profile-page">
      <section className="profile-card profile-identity">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="profile-avatar" src={imageUrl} alt="" width={72} height={72} />
        ) : (
          <div className="profile-avatar profile-avatar--initial" aria-hidden="true">
            {initial}
          </div>
        )}
        <div className="profile-identity__text">
          <h1 className="profile-identity__name">{name}</h1>
          {email ? <p className="profile-identity__email">{email}</p> : null}
          {memberSince ? <p className="profile-identity__since">Member since {memberSince}</p> : null}
        </div>
      </section>

      <section className="profile-card profile-plan">
        <div className="profile-plan__head">
          <h2 className="profile-section-title">{planTitle}</h2>
          <span className="profile-plan__badge">{plan ? "Current" : "…"}</span>
        </div>
        {isPremium ? <p className="profile-plan__lead">You have all Premium features.</p> : null}
        {isTrial && trialDays !== null ? <p className="profile-plan__lead">{trialDays} day{trialDays === 1 ? "" : "s"} left of your free trial.</p> : null}
        {plan && !isPremium ? <p className="profile-plan__lead">Premium will unlock:</p> : null}
        {plan && !isPremium ? (
          <ul className="profile-plan__list">
            {PREMIUM_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
        <Link href="/premium" className="wizard-primary-button profile-plan__upgrade">
          {!plan ? "View plan" : isPremium ? "Manage plan" : "Upgrade to Premium"}
        </Link>
      </section>

      <section className="profile-card profile-settings" aria-label="Settings">
        <h2 className="profile-section-title">Settings</h2>
        <ul className="profile-settings__list">
          <li>
            <button type="button" className="profile-settings__row" onClick={() => openUserProfile()}>
              <span>Account</span>
              <span className="profile-settings__hint">Name, email, password, Google</span>
            </button>
          </li>
          {canInstall ? (
            <li>
              <button type="button" className="profile-settings__row" onClick={() => void promptInstall()}>
                <span>Install app</span>
              </button>
            </li>
          ) : null}
          <li>
            <Link href="/how-it-works" className="profile-settings__row">
              <span>How it works</span>
            </Link>
          </li>
          <li>
            <Link href="/privacy" className="profile-settings__row">
              <span>Privacy policy</span>
            </Link>
          </li>
          <li>
            <button
              type="button"
              className="profile-settings__row profile-settings__row--danger"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut({ redirectUrl: "/how-it-works" });
              }}
            >
              <span>{signingOut ? "Signing out…" : "Sign out"}</span>
            </button>
          </li>
          <li>
            <button type="button" className="profile-settings__row profile-settings__row--danger" onClick={() => setDeleteOpen(true)}>
              <span>Delete account</span>
            </button>
          </li>
        </ul>
      </section>

      {deleteOpen ? (
        <div className="meal-planner-modal-overlay" onClick={closeDelete}>
          <div className="meal-planner-modal" role="dialog" aria-modal="true" aria-labelledby="delete-account-title" onClick={(e) => e.stopPropagation()}>
            <div className="meal-planner-modal__header">
              <h3 id="delete-account-title" className="meal-planner-modal__title">Delete your account?</h3>
              <button type="button" className="meal-planner-modal__close" aria-label="Close" onClick={closeDelete}>
                ×
              </button>
            </div>
            <div className="meal-planner-modal__body">
              <p>This can&apos;t be undone. We will delete your fridge, meal plans, shopping list, saved and private recipes, and health data.</p>
              <p>
                {isPremium
                  ? "Your Premium subscription ends straight away, with no refund for the rest of this period. "
                  : isTrial
                    ? "Your free trial ends straight away. "
                    : ""}
                We keep payment records for 6 years, as UK tax rules require.
              </p>
              <label className="profile-delete__label" htmlFor="delete-account-confirm">
                Type <strong>DELETE</strong> to confirm
              </label>
              <input
                id="delete-account-confirm"
                className="profile-delete__input"
                value={deleteText}
                onChange={(e) => setDeleteText(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                disabled={deleting}
              />
              {deleteError ? (
                <p className="profile-delete__error" role="alert">
                  {deleteError}
                </p>
              ) : null}
              <button
                type="button"
                className="profile-delete__confirm"
                disabled={deleting || deleteText.trim() !== "DELETE"}
                onClick={() => void deleteAccount()}
              >
                {deleting ? "Deleting…" : "Delete my account"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
