import { Linking } from "react-native";
import { supabase } from "@figbloom/shared";

/** Opens an exam paper's file (the paper itself, or a reference sheet) in whatever app on the phone handles it. */
export async function openExamFile(path: string): Promise<void> {
  const { data, error } = await supabase().storage.from("private-documents").createSignedUrl(path, 600);
  if (error || !data) throw new Error(error?.message ?? "The file could not be reached.");
  await Linking.openURL(data.signedUrl);
}
