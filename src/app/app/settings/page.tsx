import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { ProfileForm } from "./forms/ProfileForm";
import { ChangePasswordForm } from "./forms/ChangePasswordForm";
import { DeleteAccountForm } from "./forms/DeleteAccountForm";
import { NotificationPrefsForm } from "@/components/settings/NotificationPrefsForm";
import { TradingHoursForm } from "@/components/settings/TradingHoursForm";
import { DefaultStakingPlanForm } from "@/components/settings/DefaultStakingPlanForm";
import { PreTradeConfirmSettingsForm } from "@/components/settings/PreTradeConfirmSettingsForm";
import { MarketWarningSettingsForm } from "@/components/settings/MarketWarningSettingsForm";
import { BalanceSyncSettingsForm } from "@/components/settings/BalanceSyncSettingsForm";
import { BigWinDaySettingsForm } from "@/components/withdrawal/BigWinDaySettingsForm";
import { NewsWarningSettingsForm } from "@/components/news/NewsWarningSettingsForm";
import { TelegramSettingsForm } from "@/components/settings/TelegramSettingsForm";
import { AIReviewSettingsForm } from "@/components/settings/AIReviewSettingsForm";
import { ConnectedAccounts } from "@/components/settings/ConnectedAccounts";
import { SetPasswordForm } from "@/components/settings/SetPasswordForm";
import { SignOutAllDevicesForm } from "@/components/settings/SignOutAllDevicesForm";

export default async function SettingsPage() {
  const { name, email, timezone, baseCurrency, userId } = await requireUser();

  // Fetch all settings in one round trip.
  const [user, stakingPlans, connectedAccounts] = await Promise.all([
    db.user.findUnique({
      where: { id: userId },
      select: {
        passwordHash: true,
        notificationPrefs: true,
        tradingHours: true,
        preTradeConfirmSkipDemo: true,
        preTradeCooldownSeconds: true,
        preTradeRequirePlanCheckbox: true,
        preTradeReasonMode: true,
        marketWarningsEnabled: true,
        marketWarningsIgnoreAvoidDemo: true,
        avoidOverrideWeight: true,
        balanceSyncTolerancePercent: true,
        balanceSyncReminderFrequency: true,
        bigWinDayPercent: true,
        newsWarningEnabled: true,
        newsWarningMinutes: true,
        telegramAlertsEnabled: true,
        telegramAlertsPaused: true,
        telegramDailySummaryTime: true,
        aiReviewEnabled: true,
      },
    }),
    db.stakingPlan.findMany({
      where: { userId },
      orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
      select: { id: true, name: true, method: true, isDefault: true },
    }),
    // Phase 25: connected OAuth accounts (Google today; future providers
    // fit the same query — we just select all rows).
    db.account.findMany({
      where: { userId },
      select: {
        provider: true,
        providerAccountId: true,
        type: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const notificationPrefs =
    (user?.notificationPrefs as Record<string, { inApp: boolean; email: boolean }>) ?? null;
  const tradingHours =
    (user?.tradingHours as { start: string; end: string; days: number[] }) ?? null;

  // Phase 23: fetch the TelegramLink (for the link/unlink flow).
  const telegramLink = await db.telegramLink.findUnique({
    where: { userId },
    select: { chatId: true, username: true, verifiedAt: true },
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your account, security, and preferences.
        </p>
      </div>

      <ProfileForm defaults={{ name: name ?? "", timezone, baseCurrency }} />

      <NotificationPrefsForm prefs={notificationPrefs} />

      <TradingHoursForm defaults={tradingHours} />

      <PreTradeConfirmSettingsForm
        defaults={{
          skipDemo: user?.preTradeConfirmSkipDemo ?? false,
          cooldownSeconds: user?.preTradeCooldownSeconds ?? 5,
          requirePlanCheckbox: user?.preTradeRequirePlanCheckbox ?? false,
          reasonMode: user?.preTradeReasonMode ?? "OPTIONAL",
        }}
      />

      {/* Phase 29: live market-rating warnings + AVOID discipline weight */}
      <MarketWarningSettingsForm
        defaults={{
          warningsEnabled: user?.marketWarningsEnabled ?? true,
          ignoreAvoidOnDemo: user?.marketWarningsIgnoreAvoidDemo ?? false,
          avoidOverrideWeight: user?.avoidOverrideWeight ?? 5,
        }}
      />

      <BalanceSyncSettingsForm
        defaults={{
          tolerancePercent: Number(user?.balanceSyncTolerancePercent ?? 0.5),
          reminderFrequency: user?.balanceSyncReminderFrequency ?? "DAILY",
        }}
      />

      <BigWinDaySettingsForm
        defaults={{
          bigWinDayPercent: user?.bigWinDayPercent == null ? null : Number(user.bigWinDayPercent),
        }}
      />

      <NewsWarningSettingsForm
        defaults={{
          enabled: user?.newsWarningEnabled ?? true,
          minutes: user?.newsWarningMinutes ?? 15,
        }}
      />

      <TelegramSettingsForm
        settings={{
          linked: telegramLink != null,
          username: telegramLink?.username ?? null,
          chatId: telegramLink?.chatId ?? null,
          alertsEnabled: user?.telegramAlertsEnabled ?? true,
          alertsPaused: user?.telegramAlertsPaused ?? false,
          dailySummaryTime: user?.telegramDailySummaryTime ?? null,
          prefs:
            (user?.notificationPrefs as Record<
              string,
              { inApp: boolean; email: boolean; telegram?: boolean }
            >) ?? {},
        }}
      />

      <AIReviewSettingsForm defaults={{ enabled: user?.aiReviewEnabled ?? false }} />

      <DefaultStakingPlanForm
        plans={stakingPlans.map((p) => ({
          id: p.id,
          name: p.name,
          method: p.method,
          isDefault: p.isDefault,
        }))}
      />

      {/* Phase 25: Connected accounts (Google + future OAuth providers) */}
      <ConnectedAccounts
        accounts={connectedAccounts.map((a) => ({
          provider: a.provider,
          providerAccountId: a.providerAccountId,
          // We don't store a separate provider-side email on the Account row;
          // for Google today the linked email IS the user's email (we link by
          // email), so we surface that. For multi-provider future, the email
          // on a different provider could differ and we'd need to decode the
          // id_token (JWT) — out of scope for Phase 25.
          email: email,
          linkedAt: a.createdAt,
        }))}
        hasPassword={Boolean(user?.passwordHash)}
      />

      {/* Phase 25: Set password (Google-only users) OR Change password */}
      {user?.passwordHash ? <ChangePasswordForm /> : <SetPasswordForm />}

      {/* Phase 25: Sign out of all devices */}
      <SignOutAllDevicesForm hasPassword={Boolean(user?.passwordHash)} />

      <DeleteAccountForm email={email} />
    </div>
  );
}
