import { MealPlanWizard } from "./MealPlanWizard";

export const metadata = { title: "Build a Plan · UseItUp" };

export default function MealPlanGeneratePage() {
  return (
    <div className="wizard-page">
      <MealPlanWizard />
    </div>
  );
}
