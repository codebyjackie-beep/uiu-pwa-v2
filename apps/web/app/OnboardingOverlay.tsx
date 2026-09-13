"use client";

import { useEffect, useState } from "react";
import { useInstallPrompt } from "./lib/useInstallPrompt";

const SEEN_KEY = "uiu_onboarding_seen";

const FEATURE_CARDS = [
  { icon: "🍳", label: "Browse Recipes", hint: "Real UK prices" },
  { icon: "🧊", label: "Scan Fridge", hint: "Track what you've got" },
  { icon: "🛒", label: "Compare Prices", hint: "Shop smarter" },
  { icon: "❤️", label: "Track Health", hint: "Macros & BMI" },
] as const;

const HOW_IT_WORKS = [
  "Track what's in your fridge",
  "Get recipes & a shopping list that fits your budget",
  "Cook, log, and cut food waste",
] as const;

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
            <p className="onboarding-card__eyebrow">Welcome to UseItUp</p>
            <h2 className="onboarding-card__title">Everything in one app</h2>

            <div className="onboarding-feature-grid">
              {FEATURE_CARDS.map((f) => (
                <div className="onboarding-feature-card" key={f.label}>
                  <span className="onboarding-feature-card__icon">{f.icon}</span>
                  <span className="onboarding-feature-card__label">{f.label}</span>
                  <span className="onboarding-feature-card__hint">{f.hint}</span>
                </div>
              ))}
            </div>

            <p className="onboarding-card__subheading">How it works</p>
            <ol className="onboarding-timeline">
              {HOW_IT_WORKS.map((text, i) => (
                <li className="onboarding-timeline__item" key={text}>
                  <span className="onboarding-timeline__number">{i + 1}</span>
                  <span>{text}</span>
                </li>
              ))}
            </ol>

            <div className="onboarding-card__footer">
              <div className="onboarding-progress-dots" aria-hidden="true">
                <span className="onboarding-progress-dots__dot onboarding-progress-dots__dot--active" />
                <span className="onboarding-progress-dots__dot" />
              </div>
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
            <div className="onboarding-card__footer">
              <div className="onboarding-progress-dots" aria-hidden="true">
                <span className="onboarding-progress-dots__dot" />
                <span className="onboarding-progress-dots__dot onboarding-progress-dots__dot--active" />
              </div>
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
            </div>
          </>
        )}
      </div>
    </div>
  );
}
