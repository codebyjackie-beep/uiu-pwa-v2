"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ApiResponse, HealthGoal, MealLogEntry, MealLogTotals, UserHealthProfile, WeightLogEntry } from "@uiu/shared";
import { CoachChat } from "./CoachChat";
import { BarcodeScan } from "./BarcodeScan";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<{ res: Response; parsed: ApiResponse<T> | null }> {
  const res = await fetch(path, init);
  const parsed = (await res.json().catch(() => null)) as ApiResponse<T> | null;
  return { res, parsed };
}

const MACRO_COLORS = { protein: "#f97316", carbs: "#3b82f6", fat: "#ec4899" } as const;

function bmiOf(heightCm: number, weightKg: number): number {
  const m = heightCm / 100;
  return weightKg / (m * m);
}

function bmiCategory(bmi: number): string {
  if (bmi < 18.5) return "Underweight";
  if (bmi < 25) return "Healthy";
  if (bmi < 30) return "Overweight";
  return "Obese";
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayKey(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD, UTC — matches the API's UTC-midnight range convention.
}

function dayLabel(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
}

interface DayGroup {
  key: string;
  label: string;
  entries: MealLogEntry[];
  totalCalories: number;
}

function groupByDay(entries: MealLogEntry[]): DayGroup[] {
  const map = new Map<string, MealLogEntry[]>();
  for (const entry of entries) {
    const key = dayKey(entry.loggedAt);
    const bucket = map.get(key);
    if (bucket) bucket.push(entry);
    else map.set(key, [entry]);
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, dayEntries]) => ({
      key,
      label: dayLabel(key),
      entries: dayEntries,
      totalCalories: dayEntries.reduce((sum, e) => sum + e.calories, 0),
    }));
}

interface ProfileFormState {
  heightCm: string;
  weightKg: string;
  goal: HealthGoal;
  targetWeightKg: string;
}

function profileToForm(p: UserHealthProfile | null): ProfileFormState {
  return {
    heightCm: p ? String(p.heightCm) : "",
    weightKg: p ? String(p.weightKg) : "",
    goal: p?.goal ?? "maintain",
    targetWeightKg: p ? String(p.targetWeightKg) : "",
  };
}

/** Ring chart for today's macro split — proportioned by calorie contribution
 * (protein/carbs = 4 kcal/g, fat = 9 kcal/g), a single-purpose summary widget
 * (not an exploratory chart), so a CSS conic-gradient ring + direct-labeled
 * legend is enough — no hover layer needed. Colors reused from the existing
 * macro chips (meal-planner-nutrition__chip), validated colorblind-safe. */
function MacroRing({ totals }: { totals: MealLogTotals }) {
  const pCal = totals.protein * 4;
  const cCal = totals.carbs * 4;
  const fCal = totals.fat * 9;
  const sum = pCal + cCal + fCal;

  const gradient =
    sum > 0
      ? (() => {
          const pPct = (pCal / sum) * 100;
          const cPct = (cCal / sum) * 100;
          return `conic-gradient(${MACRO_COLORS.protein} 0% ${pPct}%, ${MACRO_COLORS.carbs} ${pPct}% ${pPct + cPct}%, ${MACRO_COLORS.fat} ${pPct + cPct}% 100%)`;
        })()
      : "conic-gradient(var(--uiu-surface-2) 0% 100%)";

  return (
    <div className="health-macro-ring-row">
      <div className="health-macro-ring" style={{ background: gradient }}>
        <div className="health-macro-ring__center">
          <span className="health-macro-ring__value">{Math.round(totals.calories)}</span>
          <span className="health-macro-ring__label">kcal</span>
        </div>
      </div>
      <div className="health-macro-legend">
        <div className="health-macro-legend__row">
          <span className="health-macro-legend__dot" style={{ background: MACRO_COLORS.protein }} />
          Protein <strong>{Math.round(totals.protein)}g</strong>
        </div>
        <div className="health-macro-legend__row">
          <span className="health-macro-legend__dot" style={{ background: MACRO_COLORS.carbs }} />
          Carbs <strong>{Math.round(totals.carbs)}g</strong>
        </div>
        <div className="health-macro-legend__row">
          <span className="health-macro-legend__dot" style={{ background: MACRO_COLORS.fat }} />
          Fat <strong>{Math.round(totals.fat)}g</strong>
        </div>
      </div>
    </div>
  );
}

/** Weight trend — single series, so no legend box (the heading names it);
 * direct value labels on the first/last point cover the accessibility bar. */
function WeightTrendChart({ logs }: { logs: WeightLogEntry[] }) {
  if (logs.length < 2) return <p className="admin-drafts-page__sub">Log at least two weights to see a trend.</p>;

  const w = 320;
  const h = 100;
  const pad = 16;
  const weights = logs.map((l) => l.weightKg);
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  const span = max - min || 1;

  const points = logs.map((l, i) => {
    const x = pad + (i / (logs.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (l.weightKg - min) / span) * (h - pad * 2);
    return { x, y, weightKg: l.weightKg };
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const first = points[0]!;
  const last = points[points.length - 1]!;

  return (
    <svg className="health-trend-chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Weight trend over recent logs">
      <path d={path} fill="none" stroke="var(--uiu-green)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={3} fill="var(--uiu-green)" />
      ))}
      <text x={first.x} y={first.y - 8} className="health-trend-chart__label" textAnchor="start">
        {first.weightKg}kg
      </text>
      <text x={last.x} y={last.y - 8} className="health-trend-chart__label" textAnchor="end">
        {last.weightKg}kg
      </text>
    </svg>
  );
}

interface HealthViewProps {
  initialProfile: UserHealthProfile | null;
  initialWeightLogs: WeightLogEntry[];
  initialMealLogs: MealLogEntry[];
  initialTotals: MealLogTotals;
}

export function HealthView({ initialProfile, initialWeightLogs, initialMealLogs, initialTotals }: HealthViewProps) {
  const [profile, setProfile] = useState(initialProfile);
  const [weightLogs, setWeightLogs] = useState(initialWeightLogs);
  const [mealLogs, setMealLogs] = useState(initialMealLogs);
  const [totals, setTotals] = useState(initialTotals);
  const [toast, setToast] = useState<string | null>(null);

  const [editingProfile, setEditingProfile] = useState(!initialProfile);
  const [profileForm, setProfileForm] = useState<ProfileFormState>(profileToForm(initialProfile));
  const [savingProfile, setSavingProfile] = useState(false);

  const [weightInput, setWeightInput] = useState("");
  const [loggingWeight, setLoggingWeight] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const [coachOpen, setCoachOpen] = useState(false);
  const [barcodeOpen, setBarcodeOpen] = useState(false);

  const [weekEntries, setWeekEntries] = useState<MealLogEntry[] | null>(null);
  const [weekTotals, setWeekTotals] = useState<MealLogTotals | null>(null);
  const [weekError, setWeekError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchJson<{ entries: MealLogEntry[]; totals: MealLogTotals }>("/api/health/meal-logs?range=week").then(({ parsed }) => {
      if (cancelled) return;
      if (!parsed || !parsed.ok) {
        setWeekError(true);
        return;
      }
      setWeekEntries(parsed.data.entries);
      setWeekTotals(parsed.data.totals);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const weekGroups = useMemo(() => (weekEntries ? groupByDay(weekEntries) : []), [weekEntries]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast((cur) => (cur === msg ? null : cur)), 3000);
  }

  const bmi = useMemo(() => {
    if (!profile) return null;
    return bmiOf(profile.heightCm, profile.weightKg);
  }, [profile]);

  async function saveProfile() {
    const heightCm = Number(profileForm.heightCm);
    const weightKg = Number(profileForm.weightKg);
    const targetWeightKg = Number(profileForm.targetWeightKg);
    if (!Number.isFinite(heightCm) || heightCm <= 0 || !Number.isFinite(weightKg) || weightKg <= 0 || !Number.isFinite(targetWeightKg) || targetWeightKg <= 0) {
      flash("Please fill in height, weight, and target weight.");
      return;
    }
    setSavingProfile(true);
    const { parsed } = await fetchJson<UserHealthProfile>("/api/health/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heightCm, weightKg, targetWeightKg, goal: profileForm.goal }),
    });
    setSavingProfile(false);
    if (!parsed || !parsed.ok) {
      flash(parsed && !parsed.ok ? `Failed to save: ${parsed.error.message}` : "Failed to save profile.");
      return;
    }
    setProfile(parsed.data);
    setEditingProfile(false);
    flash("Profile saved.");
  }

  async function logWeight() {
    const weightKg = Number(weightInput);
    if (!Number.isFinite(weightKg) || weightKg <= 0) {
      flash("Enter a valid weight.");
      return;
    }
    setLoggingWeight(true);
    const { parsed } = await fetchJson<WeightLogEntry>("/api/health/weight-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ weightKg }),
    });
    setLoggingWeight(false);
    if (!parsed || !parsed.ok) {
      flash(parsed && !parsed.ok ? `Failed: ${parsed.error.message}` : "Failed to log weight.");
      return;
    }
    setWeightLogs((prev) => [...prev, parsed.data]);
    if (profile) setProfile({ ...profile, weightKg, updatedAt: parsed.data.loggedAt });
    setWeightInput("");
    flash("Weight logged.");
  }

  function prependMealLog(entry: MealLogEntry) {
    setMealLogs((prev) => [entry, ...prev]);
    setTotals((prev) => ({
      calories: prev.calories + entry.calories,
      protein: prev.protein + entry.protein,
      carbs: prev.carbs + entry.carbs,
      fat: prev.fat + entry.fat,
    }));
  }

  async function handlePhotoFile(file: File) {
    setScanning(true);
    setScanError(null);
    const form = new FormData();
    form.append("image", file);
    const { parsed } = await fetchJson<MealLogEntry>("/api/health/meal-logs", { method: "POST", body: form });
    setScanning(false);
    if (!parsed || !parsed.ok) {
      setScanError(parsed && !parsed.ok ? parsed.error.message : "Couldn't analyze that photo, please try again.");
      return;
    }
    prependMealLog(parsed.data);
    flash(`Logged: ${parsed.data.description}`);
  }

  function handleBarcodeLogged(entry: MealLogEntry) {
    prependMealLog(entry);
    flash(`Logged: ${entry.description}`);
  }

  return (
    <div className="health-page">
      <div className="health-card__header">
        <h1>Health</h1>
        <button type="button" className="wizard-secondary-button" onClick={() => setCoachOpen(true)}>
          Ask Coach
        </button>
      </div>
      {toast ? <p className="admin-drafts-toast">{toast}</p> : null}
      {coachOpen ? <CoachChat onClose={() => setCoachOpen(false)} /> : null}
      {barcodeOpen ? <BarcodeScan onClose={() => setBarcodeOpen(false)} onLogged={handleBarcodeLogged} /> : null}

      <section className="health-card">
        <div className="health-card__header">
          <h2>Profile</h2>
          {!editingProfile ? (
            <button type="button" className="health-link-button" onClick={() => setEditingProfile(true)}>
              Edit
            </button>
          ) : null}
        </div>

        {!editingProfile && profile ? (
          <div className="health-profile-summary">
            <div className="health-stat">
              <span className="health-stat__value">{profile.heightCm}cm</span>
              <span className="health-stat__label">Height</span>
            </div>
            <div className="health-stat">
              <span className="health-stat__value">{profile.weightKg}kg</span>
              <span className="health-stat__label">Weight</span>
            </div>
            {bmi ? (
              <div className="health-stat">
                <span className="health-stat__value">{bmi.toFixed(1)}</span>
                <span className="health-stat__label">BMI · {bmiCategory(bmi)}</span>
              </div>
            ) : null}
            <div className="health-stat">
              <span className="health-stat__value">{profile.targetWeightKg}kg</span>
              <span className="health-stat__label">Target ({profile.goal})</span>
            </div>
          </div>
        ) : (
          <div className="health-profile-form">
            <div className="wizard-field-row">
              <label className="wizard-field">
                <span>Height (cm)</span>
                <input type="number" min={0} value={profileForm.heightCm} onChange={(e) => setProfileForm((f) => ({ ...f, heightCm: e.target.value }))} />
              </label>
              <label className="wizard-field">
                <span>Weight (kg)</span>
                <input type="number" min={0} value={profileForm.weightKg} onChange={(e) => setProfileForm((f) => ({ ...f, weightKg: e.target.value }))} />
              </label>
            </div>
            <div className="wizard-field-row">
              <label className="wizard-field">
                <span>Goal</span>
                <select value={profileForm.goal} onChange={(e) => setProfileForm((f) => ({ ...f, goal: e.target.value as HealthGoal }))}>
                  <option value="lose">Lose weight</option>
                  <option value="maintain">Maintain</option>
                  <option value="gain">Gain weight</option>
                </select>
              </label>
              <label className="wizard-field">
                <span>Target weight (kg)</span>
                <input type="number" min={0} value={profileForm.targetWeightKg} onChange={(e) => setProfileForm((f) => ({ ...f, targetWeightKg: e.target.value }))} />
              </label>
            </div>
            <div className="health-form-actions">
              <button type="button" className="wizard-primary-button" disabled={savingProfile} onClick={saveProfile}>
                {savingProfile ? "Saving…" : "Save profile"}
              </button>
              {profile ? (
                <button type="button" onClick={() => { setProfileForm(profileToForm(profile)); setEditingProfile(false); }} disabled={savingProfile}>
                  Cancel
                </button>
              ) : null}
            </div>
          </div>
        )}
      </section>

      <section className="health-card">
        <h2>Today</h2>
        <MacroRing totals={totals} />
        <p className="health-disclaimer">AI-estimated nutrition is approximate — not medical or dietetic advice.</p>
      </section>

      <section className="health-card">
        <div className="health-card__header">
          <h2>This week</h2>
        </div>
        {weekError ? <p className="admin-drafts-page__sub">Couldn't load this week's records.</p> : null}
        {!weekError && weekTotals ? (
          <p className="health-week-total">7-day total: {Math.round(weekTotals.calories)} kcal</p>
        ) : null}
        {!weekError && weekEntries === null ? <p className="admin-drafts-page__sub">Loading…</p> : null}
        {!weekError && weekEntries !== null && weekGroups.length === 0 ? (
          <p className="admin-drafts-page__sub">No meals logged this week.</p>
        ) : null}
        <div className="health-week-days">
          {weekGroups.map((day) => (
            <div key={day.key} className="health-week-day">
              <div className="health-week-day__header">
                <span className="health-week-day__label">{day.label}</span>
                <span className="health-week-day__total">{Math.round(day.totalCalories)} kcal</span>
              </div>
              <div className="health-meal-list">
                {day.entries.map((entry) => (
                  <div key={entry._id} className="health-meal-card">
                    <div className="health-meal-card__main">
                      <span className="health-meal-card__desc">{entry.description}</span>
                      <span className="health-meal-card__meta">
                        {formatTime(entry.loggedAt)} ·{" "}
                        {entry.source === "photo" ? "Photo" : entry.source === "barcode" ? "Barcode" : "Manual"}
                      </span>
                    </div>
                    <div className="health-meal-card__macros">
                      <span className="health-meal-card__cal">{Math.round(entry.calories)} kcal</span>
                      <span style={{ color: MACRO_COLORS.protein }}>{Math.round(entry.protein)}g</span>
                      <span style={{ color: MACRO_COLORS.carbs }}>{Math.round(entry.carbs)}g</span>
                      <span style={{ color: MACRO_COLORS.fat }}>{Math.round(entry.fat)}g</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="health-card">
        <div className="health-card__header">
          <h2>Weight</h2>
        </div>
        <div className="health-weight-log-row">
          <input
            type="number"
            min={0}
            step="any"
            placeholder="Weight (kg)"
            value={weightInput}
            onChange={(e) => setWeightInput(e.target.value)}
          />
          <button type="button" className="wizard-primary-button" disabled={loggingWeight} onClick={logWeight}>
            {loggingWeight ? "Logging…" : "Log weight"}
          </button>
        </div>
        <WeightTrendChart logs={weightLogs} />
      </section>

      <section className="health-card">
        <div className="health-card__header">
          <h2>Log a meal</h2>
        </div>
        <div className="health-meal-log-buttons">
          <button type="button" className="wizard-secondary-button" disabled={scanning} onClick={() => photoInputRef.current?.click()}>
            {scanning ? "Analyzing…" : "Take a photo"}
          </button>
          <button type="button" className="wizard-secondary-button" onClick={() => setBarcodeOpen(true)}>
            Scan barcode
          </button>
        </div>
        <input
          ref={photoInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handlePhotoFile(file);
          }}
        />
        {scanError ? <p className="admin-drafts-error">{scanError}</p> : null}
        <p className="health-disclaimer">AI-estimated nutrition is approximate — not medical or dietetic advice.</p>

        <div className="health-meal-list">
          {mealLogs.length === 0 ? <p className="admin-drafts-page__sub">No meals logged today.</p> : null}
          {mealLogs.map((entry) => (
            <div key={entry._id} className="health-meal-card">
              <div className="health-meal-card__main">
                <span className="health-meal-card__desc">{entry.description}</span>
                <span className="health-meal-card__meta">
                  {formatTime(entry.loggedAt)} ·{" "}
                  {entry.source === "photo" ? "Photo" : entry.source === "barcode" ? "Barcode" : "Manual"}
                </span>
              </div>
              <div className="health-meal-card__macros">
                <span className="health-meal-card__cal">{Math.round(entry.calories)} kcal</span>
                <span style={{ color: MACRO_COLORS.protein }}>{Math.round(entry.protein)}g</span>
                <span style={{ color: MACRO_COLORS.carbs }}>{Math.round(entry.carbs)}g</span>
                <span style={{ color: MACRO_COLORS.fat }}>{Math.round(entry.fat)}g</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
