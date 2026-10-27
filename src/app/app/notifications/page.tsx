import { Bell, CheckCheck, Circle } from "lucide-react";
import { requireUser } from "@/server/lib/require-user";
import { db } from "@/lib/db";
import { formatRelativeTime } from "@/lib/format";
import { NotificationsClient } from "./NotificationsClient";

export default async function NotificationsPage() {
  const { userId } = await requireUser();

  const [notifications, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        readAt: true,
        createdAt: true,
      },
    }),
    db.notification.count({
      where: { userId, readAt: null },
    }),
  ]);

  const serialized = notifications.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    readAt: n.readAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted-foreground">
            {unreadCount > 0
              ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
              : "All caught up"}
          </p>
        </div>
        {unreadCount > 0 && <NotificationsClient action="markAll" />}
      </div>

      {notifications.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-8 flex flex-col items-center gap-3">
          <div className="size-12 rounded-full bg-muted flex items-center justify-center">
            <Bell className="size-6 text-muted-foreground" aria-hidden="true" />
          </div>
          <h3 className="text-base font-semibold">No notifications yet</h3>
          <p className="text-sm text-muted-foreground max-w-sm text-center">
            You&apos;ll see alerts here when you approach risk limits, hit goals, or get locked out.
            Trade with discipline and you won&apos;t need many.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
          {serialized.map((n) => (
            <li
              key={n.id}
              className={`flex items-start gap-3 px-4 py-3 ${!n.readAt ? "bg-muted/30" : ""}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {!n.readAt && (
                    <Circle
                      className="size-2.5 fill-primary text-primary shrink-0"
                      aria-hidden="true"
                    />
                  )}
                  <span className="text-sm font-medium">{n.title}</span>
                  <span className="text-xs text-muted-foreground ml-auto shrink-0">
                    {formatRelativeTime(n.createdAt)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">{n.body}</p>
                <span className="text-[10px] font-mono text-muted-foreground/60 mt-1 inline-block">
                  {n.type}
                </span>
              </div>
              {!n.readAt && <NotificationsClient action="markOne" notificationId={n.id} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
