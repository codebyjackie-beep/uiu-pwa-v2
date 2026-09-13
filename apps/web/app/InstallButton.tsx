"use client";

import { useInstallPrompt } from "./lib/useInstallPrompt";

/** Manual fallback for the PWA install banner (HANDOFF_recipe-photos-and-scan-icons.md
 * §3) — Chrome doesn't guarantee an automatic banner even when SW/manifest qualify.
 * Renders nothing on browsers without beforeinstallprompt (e.g. iOS Safari).
 * Always present on Home regardless of onboarding state — see HANDOFF_welcome-page-onboarding.md. */
export function InstallButton() {
  const { canInstall, promptInstall } = useInstallPrompt();

  if (!canInstall) return null;

  return (
    <button
      type="button"
      className="wizard-secondary-button home-install-button"
      onClick={promptInstall}
    >
      Install app
    </button>
  );
}
