import type { Metadata, Viewport } from "next";
import "./globals.css";
import { BottomNav } from "./components/BottomNav";

export const metadata: Metadata = {
  title: "UseItUp",
  description: "Plan meals, track your fridge, shop smart, stay healthy.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "UseItUp" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">{children}</div>
        <BottomNav />
      </body>
    </html>
  );
}
