"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ApiResponse, MyPlan } from "@uiu/shared";
import { useClerk } from "@clerk/nextjs";
import { useInstallPrompt } from "../lib/useInstallPrompt";

const PREMIUM_FEATURES = ["AI Nutrition Coach", "AI meal plan wizard", "Barcode scan", "Fridge photo & receipt scan"];

export function ProfileView({ name, email, imageUrl, memberSince }: { name: string; email: string; imageUrl: string | null; memberSince: string | null }) {
  const { openUserProfile, signOut } = useClerk();
  const { canInstall, promptInstall } = useInstallPrompt();
  const [signingOut, setSigningOut] = useState(false);
  const [plan, setPlan] = useState<MyPlan | null>(null);
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
  const planTitle = isPremium ? "Premium" : isTrial ? "Free trial" : "Free plan";
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
        {!isPremium ? <p className="profile-plan__lead">Premium will unlock:</p> : null}
        {!isPremium ? (
          <ul className="profile-plan__list">
            {PREMIUM_FEATURES.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}
        <Link href="/premium" className="wizard-primary-button profile-plan__upgrade">
          {isPremium ? "Manage plan" : "Upgrade to Premium"}
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
        </ul>
      </section>

    </div>
  );
}
