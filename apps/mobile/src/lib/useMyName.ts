import { useEffect, useState } from "react";
import { supabase } from "@figbloom/shared";

/** The signed-in user's full name, "" until it loads (or if it can't): a starting point for forms that ask for it. */
export function useMyName(): string {
  const [name, setName] = useState("");
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: { user } } = await supabase().auth.getUser();
      if (!user) return;
      const { data } = await supabase().from("profiles").select("full_name").eq("id", user.id).maybeSingle<{ full_name: string }>();
      if (alive && data) setName(data.full_name);
    })().catch(() => { /* the form just starts empty */ });
    return () => { alive = false; };
  }, []);
  return name;
}
