import { supabase } from "./supabase";

/**
 * "Edit my own name/phone/photo" — the one thing every role's Account
 * screen needs, web or mobile. login_id/email/role stay read-only callers'
 * side; this only ever touches full_name/phone/avatar_url.
 */
export interface MyProfile {
  full_name: string;
  phone: string | null;
  avatar_url: string | null;
  login_id: string | null;
  email: string | null;
}

export async function fetchMyProfile(id: string): Promise<MyProfile> {
  const { data, error } = await supabase()
    .from("profiles").select("full_name, phone, avatar_url, login_id, email").eq("id", id)
    .single<MyProfile>();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateMyProfile(id: string, fields: { full_name: string; phone: string | null }): Promise<void> {
  const { error } = await supabase().from("profiles").update(fields).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function updateMyAvatarUrl(id: string, avatarUrl: string): Promise<void> {
  const { error } = await supabase().from("profiles").update({ avatar_url: avatarUrl }).eq("id", id);
  if (error) throw new Error(error.message);
}
