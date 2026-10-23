/**
 * A one-time starting password for an account someone else creates on a
 * person's behalf (an admin adding a teacher, guardian, learner, ...). The
 * admin reads it off the screen and hands it over, so look-alike characters
 * (0/O, 1/l/I) are left out; the person replaces it with their own at first
 * sign-in (profiles.must_change_password).
 *
 * Every account used to get the same fixed "figbloom-dev" password, which
 * together with sequential login IDs let anyone sign in as anyone.
 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function tempPassword(length = 10): string {
  // Rejection sampling: bytes past the last whole multiple of the alphabet
  // size are discarded, so every character is equally likely.
  const limit = 256 - (256 % ALPHABET.length);
  const out: string[] = [];
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < limit) out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}
