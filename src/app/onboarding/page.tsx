import { AuthShell } from "@/components/auth/AuthShell";
import { OnboardingWizard } from "./OnboardingWizard";

export default function OnboardingPage() {
  return (
    <AuthShell title="Welcome to RiskGuard" subtitle="Let's set you up in 3 quick steps">
      <OnboardingWizard />
    </AuthShell>
  );
}
