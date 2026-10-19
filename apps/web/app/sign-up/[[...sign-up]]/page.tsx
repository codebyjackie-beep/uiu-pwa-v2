import { SignUp } from "@clerk/nextjs";
import { AuthPageGuard } from "../../components/AuthPageGuard";

export default function SignUpPage() {
  return (
    <div className="auth-page">
      <AuthPageGuard>
        <SignUp />
      </AuthPageGuard>
    </div>
  );
}
