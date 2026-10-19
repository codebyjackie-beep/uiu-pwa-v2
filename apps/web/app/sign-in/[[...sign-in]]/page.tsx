import { SignIn } from "@clerk/nextjs";
import { AuthPageGuard } from "../../components/AuthPageGuard";

export default function SignInPage() {
  return (
    <div className="auth-page">
      <AuthPageGuard>
        <SignIn />
      </AuthPageGuard>
    </div>
  );
}
