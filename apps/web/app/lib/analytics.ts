/**
 * PostHog product analytics, consent-gated (UK PECR / UK GDPR).
 *
 * - Nothing PostHog-related runs before the visitor taps Accept: `posthog-js` is only fetched through the dynamic
 *   `import()` in `loadPostHog()`, which is only called once consent is "granted". Before that there is no PostHog
 *   script, request, cookie or localStorage key (keeps /how-it-works' Lighthouse score from PR #51).
 * - The consent choice itself is one small first-party cookie, `uiu_consent` (strictly necessary: it records the
 *   choice so we don't ask again). The server layout reads it so the banner is rendered (or not) on the first paint.
 * - Only these events can leave the browser: `$pageview`, `$pageleave`, `$identify` (Clerk user id only) and
 *   `sign_up_completed`. `beforeSend` drops everything else and strips every URL down to path + `utm_*`.
 * - Health data is never sent: no component captures anything, there is no autocapture / recording / console log
 *   capture, and pageviews carry the path only.
 */
import type { CaptureResult, PostHog, Properties } from "posthog-js";

export type ConsentState = "granted" | "denied" | "unset";

export const CONSENT_COOKIE = "uiu_consent";
const CONSENT_MAX_AGE_S = 60 * 60 * 24 * 365; // ask again after 12 months

/** localStorage flag (value = Clerk user id) so `sign_up_completed` is sent once per browser. Removed on Reject. */
export const SIGNUP_TRACKED_KEY = "uiu_signup_tracked";

export const EU_UI_HOST = "https://eu.posthog.com";

/** The only events allowed out of the browser. */
const ALLOWED_EVENTS = new Set(["$pageview", "$pageleave", "$identify", "sign_up_completed"]);

export function parseConsent(value: string | undefined | null): ConsentState {
  return value === "granted" || value === "denied" ? value : "unset";
}

export function writeConsentCookie(state: "granted" | "denied"): void {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${CONSENT_COOKIE}=${state}; Max-Age=${CONSENT_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`;
}

/** Any absolute URL with a scheme, e.g. `https://…` or a TWA referrer like `android-app://…`. */
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Absolute URL → origin + path, keeping only `utm_*` query parameters and dropping the #hash.
 * Works for any scheme, not only http(s). Fails closed: if the URL can't be parsed, the whole query + hash is dropped.
 * Anything that is not an absolute URL with a scheme is returned unchanged.
 */
export function stripUrl(value: string): string {
  if (!SCHEME_URL.test(value)) return value;
  const base = value.split(/[?#]/)[0];
  try {
    const url = new URL(value);
    const kept = new URLSearchParams();
    url.searchParams.forEach((v, k) => {
      if (k.toLowerCase().startsWith("utm_")) kept.append(k, v);
    });
    const query = kept.toString();
    // Non-http(s) schemes have an opaque origin ("null"), so use the raw part before ?/# instead.
    const path = /^https?:$/i.test(url.protocol) ? `${url.origin}${url.pathname}` : base;
    return `${path}${query ? `?${query}` : ""}`;
  } catch {
    return base;
  }
}

function stripUrlsIn(props: Properties | undefined): void {
  if (!props) return;
  for (const key of Object.keys(props)) {
    const v = props[key];
    if (typeof v === "string") props[key] = stripUrl(v);
  }
}

/** posthog `before_send`: allow-list events, strip query strings (except utm_*) from every URL, drop page titles. */
export function beforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!capturingAllowed || !event || !ALLOWED_EVENTS.has(event.event)) return null;
  stripUrlsIn(event.properties);
  stripUrlsIn(event.$set);
  stripUrlsIn(event.$set_once);
  // "pageview only sends the path": the document title is not needed.
  if (event.properties) delete event.properties.title;
  return event;
}

let posthogPromise: Promise<PostHog> | null = null;
/** Second guard next to posthog's own opt-out: false until Accept, and false again as soon as the visitor rejects. */
let capturingAllowed = false;

export function setCapturingAllowed(allowed: boolean): void {
  capturingAllowed = allowed;
}

/** Loads + initialises posthog-js once. Only call after consent is "granted". */
export function loadPostHog(key: string, apiHost: string): Promise<PostHog> {
  if (!posthogPromise) {
    posthogPromise = import("posthog-js").then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: apiHost,
        ui_host: EU_UI_HOST,
        person_profiles: "identified_only",
        autocapture: false,
        capture_pageview: "history_change",
        capture_pageleave: true,
        disable_session_recording: true,
        disable_surveys: true,
        capture_exceptions: false,
        enable_recording_console_log: false,
        mask_all_text: true,
        mask_all_element_attributes: true,
        // Belt and braces: nothing else may be switched on remotely from the PostHog project settings.
        capture_performance: false,
        capture_heatmaps: false,
        capture_dead_clicks: false,
        rageclick: false,
        disable_web_experiments: true,
        disable_product_tours: true,
        disable_conversations: true,
        advanced_disable_flags: true,
        disable_external_dependency_loading: true,
        // Opting out also switches posthog's own persistence off (no cookie / localStorage rewritten afterwards).
        opt_out_persistence_by_default: true,
        before_send: beforeSend,
      });
      // A visitor who rejected earlier and has now accepted again: undo the earlier opt-out without the extra $opt_in event.
      if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing({ captureEventName: false });
      return posthog;
    });
    posthogPromise.catch(() => {
      posthogPromise = null; // e.g. chunk failed to load offline — allow a retry on the next consent change
    });
  }
  return posthogPromise;
}

/** The instance if it has already been loaded in this page (never triggers a load). */
export function loadedPostHog(): Promise<PostHog> | null {
  return posthogPromise;
}

function parentDomains(hostname: string): string[] {
  const parts = hostname.split(".");
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join("."));
  return out;
}

/**
 * Remove every cookie / storage key posthog-js writes (`ph_*`, `__ph_*`), plus our own `uiu_signup_tracked` flag (it
 * holds a Clerk user id). Our own `uiu_consent` cookie is kept.
 * `keepOptOut`: while posthog is still loaded in this page, keep its `__ph_opt_in_out_*` opt-out flag (localStorage, no
 * tracking data) so the live instance stays opted out; it is removed on the next page load, when posthog is not loaded.
 */
export function clearPostHogStorage({ keepOptOut = false }: { keepOptOut?: boolean } = {}): void {
  const isPostHogKey = (k: string) =>
    k === SIGNUP_TRACKED_KEY ||
    ((k.startsWith("ph_") || k.startsWith("__ph")) && !(keepOptOut && k.startsWith("__ph_opt_in_out_")));
  try {
    for (const c of document.cookie.split("; ")) {
      const name = c.split("=")[0];
      if (!name || !isPostHogKey(name)) continue;
      const expire = `${name}=; Max-Age=0; Path=/`;
      document.cookie = expire;
      for (const d of parentDomains(window.location.hostname)) document.cookie = `${expire}; Domain=.${d}`;
    }
  } catch {
    // ignore
  }
  for (const storage of [safeStorage("localStorage"), safeStorage("sessionStorage")]) {
    if (!storage) continue;
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && isPostHogKey(k)) keys.push(k);
      }
      keys.forEach((k) => storage.removeItem(k));
    } catch {
      // ignore
    }
  }
}

function safeStorage(kind: "localStorage" | "sessionStorage"): Storage | null {
  try {
    return window[kind];
  } catch {
    return null;
  }
}
