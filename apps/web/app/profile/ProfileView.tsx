"use client";

import Link from "next/link";
import { useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { useInstallPrompt } from "../lib/useInstallPrompt";

const PREMIUM_FEATURES = ["AI Nutrition Coach", "AI meal plan wizard", "Barcode scan", "Fridge photo & receipt scan"];

export function ProfileView({ name, email, imageUrl, memberSince }: { name: string; email: string; imageUrl: string | null; memberSince: string | null }) {
  const { openUserProfile, signOut } = useClerk();
  const { canInstall, promptInstall } = useInstallPrompt();
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const initial = (name.trim()[0] ?? "?").toUpperCase();

  return (
    <main className="profile-page">
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
          <h2 className="profile-section-title">Free plan</h2>
          <span className="profile-plan__badge">Current</span>
        </div>
        <p className="profile-plan__lead">Premium will unlock:</p>
        <ul className="profile-plan__list">
          {PREMIUM_FEATURES.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <button type="button" className="wizard-primary-button profile-plan__upgrade" onClick={() => setUpgradeOpen(true)}>
          Upgrade to Premium
        </button>
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

      {upgradeOpen ? (
        <div className="meal-planner-modal-overlay" onClick={() => setUpgradeOpen(false)}>
          <div className="meal-planner-modal" role="dialog" aria-modal="true" aria-labelledby="upgrade-title" onClick={(e) => e.stopPropagation()}>
            <div className="meal-planner-modal__header">
              <h3 id="upgrade-title" className="meal-planner-modal__title">
                Premium is coming soon
              </h3>
              <button type="button" className="meal-planner-modal__close" aria-label="Close" onClick={() => setUpgradeOpen(false)}>
                ×
              </button>
            </div>
            <div className="meal-planner-modal__body">
              <p className="profile-upgrade__text">
                We&apos;re still building Premium. Everything you use today stays free, and nothing will change on your account without you choosing it.
              </p>
              <button type="button" className="wizard-primary-button profile-plan__upgrade" onClick={() => setUpgradeOpen(false)}>
                OK
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
