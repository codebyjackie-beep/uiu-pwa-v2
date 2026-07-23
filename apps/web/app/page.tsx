import { API_VERSION } from "@uiu/shared";

const TABS = ["Home", "Meal Planner", "Recipes", "Shop", "Fridge", "Health"] as const;

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space)",
        padding: "calc(var(--space) * 2)",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 12,
          letterSpacing: 2,
          textTransform: "uppercase",
          color: "var(--accent)",
        }}
      >
        UseItUp · v2
      </div>
      <h1 style={{ fontSize: 40, margin: 0 }}>Rebuild in progress</h1>
      <p style={{ color: "var(--uiu-muted)", maxWidth: 480, margin: 0 }}>
        Next.js + Cloudflare Workers PWA scaffold. Shared types v{API_VERSION}.
      </p>
      <nav
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          justifyContent: "center",
          marginTop: "var(--space)",
        }}
      >
        {TABS.map((t) => (
          <span
            key={t}
            style={{
              padding: "8px 14px",
              borderRadius: 999,
              background: "var(--card)",
              border: "1px solid var(--accent)",
              fontSize: 14,
            }}
          >
            {t}
          </span>
        ))}
      </nav>
    </main>
  );
}
