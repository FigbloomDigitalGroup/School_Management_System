import { useEffect, useState } from "react";
import { supabase } from "@figbloom/shared";

export interface ChatSession {
  profileId: string;
  tenantId: string;
}

/** Who is signed in and at which school, for the chat screens (null until it loads, or if there is no school). */
export function useChatSession(): ChatSession | null {
  const [session, setSession] = useState<ChatSession | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) return;
      const { data } = await supabase().from("profiles").select("tenant_id").eq("id", user.id).maybeSingle<{ tenant_id: string | null }>();
      if (alive && data?.tenant_id) setSession({ profileId: user.id, tenantId: data.tenant_id });
    })().catch(() => { /* the chat screens show their own loading state */ });
    return () => { alive = false; };
  }, []);
  return session;
}
