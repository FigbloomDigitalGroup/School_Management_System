import { useState } from "react";
import {
  DEFAULT_NOTIFICATION_PREFERENCES, fetchMyNotificationPreferences, notificationTopicsFor, setMyNotificationPreference,
  type NotificationPreferences, type Role,
} from "@figbloom/shared";
import { useAsync } from "../../lib/useAsync";
import { Skeleton } from "../ui/Skeleton";
import { useToast } from "../ui/Toast";
import { AccountCard } from "./AccountCard";

/**
 * "How we reach you": the choices a role has, saved on the server as soon as a switch is flipped. Only the one switch that
 * changed is sent, so two tabs never overwrite each other. A person who never chose reads as the product's defaults.
 */
export function NotificationChoices({ role, profileId }: { role: Role; profileId: string }) {
  const toast = useToast();
  const { data, error } = useAsync(() => fetchMyNotificationPreferences(profileId), [profileId]);
  const [local, setLocal] = useState<Partial<NotificationPreferences>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const topics = notificationTopicsFor(role);

  async function flip(key: keyof NotificationPreferences, value: boolean) {
    setSaving(key);
    setLocal((l) => ({ ...l, [key]: value }));
    try {
      await setMyNotificationPreference(profileId, { [key]: value });
    } catch (err) {
      setLocal((l) => ({ ...l, [key]: !value }));
      toast(err instanceof Error ? `Could not save: ${err.message}` : "Could not save.", "error");
    } finally {
      setSaving(null);
    }
  }

  return (
    <AccountCard title="How we reach you" lead="Choose which messages reach your phone. Everything still shows in the app.">
      {error ? (
        <p role="alert" className="text-[12.5px] text-warn-ink">Could not load your choices: {error.message}</p>
      ) : !data ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ul className="-my-1">
          {topics.map((t) => {
            const on = local[t.key] ?? data[t.key] ?? DEFAULT_NOTIFICATION_PREFERENCES[t.key];
            const id = `notify-${t.key}`;
            return (
              <li key={t.key} className="flex items-center gap-3 border-b border-line-soft py-3 last:border-0">
                <label htmlFor={id} className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{t.label}</span>
                  <span className="mt-0.5 block text-[11.5px] text-ink-faint">{t.note}</span>
                </label>
                <input
                  id={id} type="checkbox" role="switch" checked={on} disabled={saving === t.key}
                  onChange={(e) => void flip(t.key, e.target.checked)}
                  className="h-5 w-5 shrink-0" style={{ accentColor: "var(--accent-deep, #17402A)" }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </AccountCard>
  );
}
