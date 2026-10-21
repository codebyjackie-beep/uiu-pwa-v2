"use client";

import { useEffect, useState } from "react";
import { useGuestGate } from "../components/GuestGate";

function urlB64ToUint8Array(b64: string): Uint8Array {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

type State = "unsupported" | "loading" | "off" | "on" | "blocked" | "busy";

/** Use-it-up reminders (research_rminder_competitors.md #1): one push a day (18:00 UK) when fridge items expire today/tomorrow.
 * Account only — a guest tap opens the sign-up sheet. On iPhone, push needs the app installed to the Home Screen (iOS 16.4+). */
export function ReminderToggle() {
  const { isSignedIn, requireAccount } = useGuestGate();
  const [state, setState] = useState<State>("loading");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      setState("unsupported");
      return;
    }
    if (Notification.permission === "denied") {
      setState("blocked");
      return;
    }
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => setState(sub ? "on" : "off"))
      .catch(() => setState("off"));
  }, []);

  async function turnOn() {
    if (!requireAccount()) return;
    setState("busy");
    setNote(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setState(perm === "denied" ? "blocked" : "off");
        return;
      }
      const keyRes = (await (await fetch("/api/push/public-key")).json()) as { ok: boolean; data?: { publicKey: string | null } };
      const publicKey = keyRes.ok ? keyRes.data?.publicKey : null;
      if (!publicKey) throw new Error("no key");
      const reg = await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey).buffer as ArrayBuffer }));
      const saved = (await (await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sub.toJSON()) })).json()) as { ok: boolean };
      if (!saved.ok) throw new Error("save failed");
      setState("on");
      setNote("We'll remind you at 6pm when something in your fridge expires today or tomorrow.");
    } catch {
      setState("off");
      setNote("Couldn't turn reminders on — please try again.");
    }
  }

  async function turnOff() {
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/unsubscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => null);
        await sub.unsubscribe();
      }
    } finally {
      setState("off");
      setNote(null);
    }
  }

  if (state === "loading") return null;
  if (state === "unsupported") {
    return <p className="reminder-toggle__note">Expiry reminders need the app installed to your Home Screen (iPhone: Share → Add to Home Screen).</p>;
  }
  if (state === "blocked") {
    return <p className="reminder-toggle__note">Notifications are blocked for UseItUp — allow them in your phone or browser settings to get expiry reminders.</p>;
  }
  return (
    <div className="reminder-toggle">
      {state === "on" ? (
        <button type="button" className="reminder-toggle__btn reminder-toggle__btn--on" onClick={() => void turnOff()}>
          🔔 Expiry reminders on · Turn off
        </button>
      ) : (
        <button type="button" className="reminder-toggle__btn" disabled={state === "busy"} onClick={() => void turnOn()}>
          {state === "busy" ? (
            "Turning on…"
          ) : (
            <>
              🔔 Remind me before food expires
              {isSignedIn ? null : <span className="reminder-toggle__sub">Free account</span>}
            </>
          )}
        </button>
      )}
      {note ? <p className="reminder-toggle__note">{note}</p> : null}
    </div>
  );
}
