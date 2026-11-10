import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import { auth } from "@clerk/nextjs/server";
import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "@fontsource/bricolage-grotesque/800.css";
import "./globals.css";
import { AppHeader } from "./components/AppHeader";
import { BottomNav } from "./components/BottomNav";
import { AppShell, GuestBanner } from "./components/GuestGate";
import { AuthProviders, type ClerkClientProps } from "./components/AuthProviders";
import { ServiceWorkerKillSwitch } from "./components/ServiceWorkerKillSwitch";
import { PremiumGate } from "./components/PremiumGate";
import { SiteFooter } from "./components/SiteFooter";
import { AnalyticsProvider } from "./components/Analytics";
import { CONSENT_COOKIE, parseConsent } from "./lib/analytics";

export const metadata: Metadata = {
  metadataBase: new URL("https://useitup.uk"),
  title: "UseItUp",
  description: "Plan meals, track your fridge, shop smart, stay healthy.",
  // Link previews (IG bio, WhatsApp, iMessage, X) — 1200×630 share card.
  openGraph: {
    type: "website",
    url: "https://useitup.uk",
    siteName: "UseItUp",
    title: "UseItUp — cook what's about to go off",
    description: "See what to use first, what to cook, and what it costs at UK supermarkets. Free, no sign-up to try.",
    images: [{ url: "/og-image.png?v=1", width: 1200, height: 630, alt: "UseItUp app: use it up soon, recipes priced at UK supermarkets" }],
    locale: "en_GB",
  },
  twitter: {
    card: "summary_large_image",
    title: "UseItUp — cook what's about to go off",
    description: "See what to use first, what to cook, and what it costs at UK supermarkets. Free, no sign-up to try.",
    images: ["/og-image.png?v=1"],
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/favicon-32.png", sizes: "32x32", type: "image/png" }, { url: "/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "UseItUp" },
  // Pinterest business account: claim useitup.uk (renders <meta name="p:domain_verify">).
  other: { "p:domain_verify": "3df1554a48d017076c9122fd4ea4d7c7" },
};

export const viewport: Viewport = {
  themeColor: "#f3ede2",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const hdrs = await headers();
  // shop.useitup.uk is a public marketing page, not part of the app shell — no bottom nav / SW.
  const isPublicShop = (hdrs.get("host") ?? "") === "shop.useitup.uk";
  const { userId } = isPublicShop ? { userId: null } : await auth();
  // Read at request time (Workers vars, wrangler.toml) — the CI build has no NEXT_PUBLIC_CLERK_* to inline.
  const clerkProps: ClerkClientProps = {
    publishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "",
    signInUrl: "/sign-in",
    signUpUrl: "/sign-up",
    afterSignOutUrl: "/how-it-works",
    signInFallbackRedirectUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL || undefined,
    signUpFallbackRedirectUrl: process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL || undefined,
  };

  // PostHog: runtime Workers vars, like the Clerk props above. Not on shop.useitup.uk (no banner, no tracking).
  const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY ?? "";
  const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "";
  const initialConsent = parseConsent((await cookies()).get(CONSENT_COOKIE)?.value);

  const app = (
    <AuthProviders serverSignedIn={!!userId} clerkProps={clerkProps}>
      {!isPublicShop && <ServiceWorkerKillSwitch />}
      {!isPublicShop && <AppHeader />}
      <AppShell publicShop={isPublicShop}>
        {!isPublicShop && <GuestBanner />}
        {children}
      </AppShell>
      {!isPublicShop && <PremiumGate />}
      {!isPublicShop && <SiteFooter />}
      {!isPublicShop && <BottomNav />}
    </AuthProviders>
  );

  return (
    <html lang="en">
      <body>
        {isPublicShop ? (
          app
        ) : (
          <AnalyticsProvider posthogKey={posthogKey} posthogHost={posthogHost} initialConsent={initialConsent}>
            {app}
          </AnalyticsProvider>
        )}
      </body>
    </html>
  );
}
