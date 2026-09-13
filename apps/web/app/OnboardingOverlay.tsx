"use client";

import { useEffect, useState } from "react";
import { useInstallPrompt } from "./lib/useInstallPrompt";

const SEEN_KEY = "uiu_onboarding_seen";

/** First-open onboarding overlay on the Home tab (HANDOFF_welcome-page-onboarding.md).
 * Not a route — a modal layered over Home. Shown once per browser (localStorage flag),
 * never shown again after skip/finish. Independent from the always-present
 * InstallButton on Home — see useInstallPrompt for the shared install logic. */
export function OnboardingOverlay() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const { canInstall, promptInstall } = useInstallPrompt();

  useEffect(() => {
    let seen = true;
    try {
      seen = window.localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      seen = true;
    }
    if (!seen) setVisible(true);
  }, []);

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(SEEN_KEY, "1");
    } catch {
      // localStorage unavailable — nothing to persist, overlay just shows again next time.
    }
  };

  if (!visible) return null;

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true">
      <div className="onboarding-card">
        {step === 0 ? (
          <>
            <p className="onboarding-card__eyebrow">Welcome</p>
            <h2 className="onboarding-card__title">UseItUp</h2>
            <p className="onboarding-card__body">
              Plan meals, track your fridge, shop smarter, and stay healthy — all in
              one place, with real UK prices across 214 recipes.
            </p>
            <div className="onboarding-card__actions">
              <button type="button" className="wizard-secondary-button" onClick={dismiss}>
                Skip
              </button>
              <button
                type="button"
                className="wizard-primary-button"
                onClick={() => setStep(1)}
              >
                Next →
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="onboarding-card__eyebrow">Get the app</p>
            <h2 className="onboarding-card__title">Install UseItUp</h2>
            <p className="onboarding-card__body">
              Add UseItUp to your home screen for quick access, like a regular app.
            </p>
            <ul className="onboarding-card__steps">
              <li>
                <strong>iPhone/iPad (Safari):</strong> tap Share ⬆️, then &quot;Add to Home
                Screen&quot;.
              </li>
              <li>
                <strong>Android/Chrome:</strong> tap the menu ⋮, then &quot;Install app&quot;
                — or use the button below.
              </li>
            </ul>
            <div className="onboarding-card__actions">
              {canInstall && (
                <button
                  type="button"
                  className="wizard-secondary-button"
                  onClick={promptInstall}
                >
                  Install now
                </button>
              )}
              <button type="button" className="wizard-primary-button" onClick={dismiss}>
                Got it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
