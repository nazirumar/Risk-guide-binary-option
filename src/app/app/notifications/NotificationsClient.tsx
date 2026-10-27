"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/server/actions/notifications";
import { toast } from "@/hooks/use-toast";
import { Check, CheckCheck } from "lucide-react";

export function NotificationsClient({
  action,
  notificationId,
}: {
  action: "markAll" | "markOne";
  notificationId?: string;
}) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (action === "markAll") {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            await markAllNotificationsReadAction();
            toast({ title: "All notifications marked as read" });
            router.refresh();
          });
        }}
      >
        <CheckCheck className="size-4 mr-1.5" aria-hidden="true" />
        {pending ? "Marking…" : "Mark all read"}
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      disabled={pending}
      aria-label="Mark as read"
      title="Mark as read"
      onClick={() => {
        if (!notificationId) return;
        const fd = new FormData();
        fd.set("notificationId", notificationId);
        startTransition(async () => {
          await markNotificationReadAction(fd);
          router.refresh();
        });
      }}
    >
      <Check className="size-3.5" aria-hidden="true" />
    </Button>
  );
}
