import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { ProfileForm } from "./ProfileForm";
import { ChangePasswordForm } from "./ChangePasswordForm";
import { DeleteAccountForm } from "./DeleteAccountForm";
import { ConnectedAccounts } from "@/components/settings/ConnectedAccounts";
import { SetPasswordForm } from "@/components/settings/SetPasswordForm";
import { SignOutAllDevicesForm } from "@/components/settings/SignOutAllDevicesForm";

/**
 * Phase 25 — /app/profile page mirrors /app/settings' security sections:
 * Profile + Connected accounts + (Set password | Change password) +
 * Sign out of all devices + Delete account. The two pages share the same
 * forms so users can manage their security from either place.
 */
export default async function ProfilePage() {
  const { name, email, timezone, baseCurrency, userId } = await requireUser();

  // One round trip for everything we need.
  const [user, connectedAccounts] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    }),
    db.account.findMany({
      where: { userId },
      select: {
        provider: true,
        providerAccountId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account, security, and preferences.
        </p>
      </div>

      <ProfileForm defaults={{ name: name ?? "", timezone, baseCurrency }} />

      <ConnectedAccounts
        accounts={connectedAccounts.map((a) => ({
          provider: a.provider,
          providerAccountId: a.providerAccountId,
          email,
          linkedAt: a.createdAt,
        }))}
        hasPassword={Boolean(user?.passwordHash)}
      />

      {user?.passwordHash ? <ChangePasswordForm /> : <SetPasswordForm />}

      <SignOutAllDevicesForm hasPassword={Boolean(user?.passwordHash)} />

      <DeleteAccountForm email={email} />
    </div>
  );
}
