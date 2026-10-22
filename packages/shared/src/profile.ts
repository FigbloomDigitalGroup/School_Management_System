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

/** full_name is optional: a driver's name is the school's to change, not theirs
 *  (guard_profile_self_edit, 20261007010000_profile_self_edit.sql). */
export async function updateMyProfile(id: string, fields: { full_name?: string; phone: string | null }): Promise<void> {
  const { error } = await supabase().from("profiles").update(fields).eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * Replace an admin-issued password with one of the person's own, and clear
 * the "choose your own password" prompt that came with it.
 */
export async function setMyPassword(id: string, password: string): Promise<void> {
  const { error } = await supabase().auth.updateUser({ password });
  if (error) throw new Error(error.message);
  const { error: flagErr } = await supabase().from("profiles").update({ must_change_password: false }).eq("id", id);
  if (flagErr) throw new Error(flagErr.message);
}

export async function updateMyAvatarUrl(id: string, avatarUrl: string): Promise<void> {
  const { error } = await supabase().from("profiles").update({ avatar_url: avatarUrl }).eq("id", id);
  if (error) throw new Error(error.message);
}
