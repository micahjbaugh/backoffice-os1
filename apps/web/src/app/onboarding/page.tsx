import { ActionForm, SubmitButton } from "@/components/ActionForm";
import { requireUser } from "@/server/session";
import { createOrganizationAction, signOutAction } from "../actions/auth";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await requireUser();
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="page-head">
          <h1>Set up your business</h1>
          <p>Signed in as {user.email}. You&apos;ll be the owner of this organization.</p>
        </div>
        <div className="card">
          <ActionForm action={createOrganizationAction} className="stack" resetOnSuccess={false}>
            <label>
              Business name
              <input name="name" required maxLength={200} />
            </label>
            <label>
              Short name (optional, lowercase-with-dashes)
              <input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={64} />
            </label>
            <label>
              Time zone
              <select name="timezone" defaultValue="America/Chicago">
                <option>America/New_York</option>
                <option>America/Chicago</option>
                <option>America/Denver</option>
                <option>America/Phoenix</option>
                <option>America/Los_Angeles</option>
              </select>
            </label>
            <SubmitButton>Create organization</SubmitButton>
          </ActionForm>
        </div>
        <form action={signOutAction}>
          <button className="btn link" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
