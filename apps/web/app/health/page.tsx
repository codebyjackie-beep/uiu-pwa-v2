import type { MealLogEntry, MealLogTotals, UserHealthProfile, WeightLogEntry } from "@uiu/shared";
import { apiGet } from "../lib/api";
import { HealthView } from "./HealthView";

export const metadata = { title: "Health · UseItUp" };

export default async function HealthPage() {
  const [profileRes, weightLogsRes, mealLogsRes] = await Promise.all([
    apiGet<UserHealthProfile | null>("/api/health/profile"),
    apiGet<WeightLogEntry[]>("/api/health/weight-logs"),
    apiGet<{ entries: MealLogEntry[]; totals: MealLogTotals }>("/api/health/meal-logs?range=today"),
  ]);

  return (
    <HealthView
      initialProfile={profileRes.ok ? profileRes.data : null}
      initialWeightLogs={weightLogsRes.ok ? weightLogsRes.data : []}
      initialMealLogs={mealLogsRes.ok ? mealLogsRes.data.entries : []}
      initialTotals={mealLogsRes.ok ? mealLogsRes.data.totals : { calories: 0, protein: 0, carbs: 0, fat: 0 }}
    />
  );
}
