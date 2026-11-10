import { Linking } from "react-native";
import { fileLink } from "@figbloom/shared";

/** Opens an exam paper's file (the paper itself, or a reference sheet) in whatever app on the phone handles it. */
export async function openExamFile(path: string): Promise<void> {
  await Linking.openURL(await fileLink("private-documents", path, 600));
}
