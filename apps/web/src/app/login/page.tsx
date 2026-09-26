import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { getCurrentUser } from "@/server/session";
import { signInAction, signUpAction } from "../actions/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/inbox");
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="page-head">
          <h1>Back Office OS</h1>
          <p>You run the work. We run the office.</p>
        </div>
        <div className="card">
          <h2>Sign in</h2>
          <ActionForm action={signInAction} className="stack" resetOnSuccess={false}>
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <SubmitButton>Sign in</SubmitButton>
          </ActionForm>
          <details>
            <summary>New here? Create an account</summary>
            <ActionForm action={signUpAction} className="stack" resetOnSuccess={false}>
              <label>
                Email
                <input name="email" type="email" autoComplete="email" required />
              </label>
              <label>
                Password (10+ characters)
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={10}
                  required
                />
              </label>
              <SubmitButton variant="secondary">Create account</SubmitButton>
            </ActionForm>
          </details>
        </div>
      </div>
    </div>
  );
}
