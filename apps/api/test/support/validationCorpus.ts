/**
 * Pinned validation corpus (Stage Z). Expected results are written down here,
 * not derived from whatever the installed Zod version answers: the corpus was
 * recorded against Zod 3.25.76 before the upgrade and is the contract the
 * upgrade must preserve (DEC-02).
 */
export const UUID_ACCEPT: readonly string[] = [
  "00000000-0000-4000-8000-000000000001", // RFC v4, the shape of the suite's fixtures
  "123e4567-e89b-12d3-a456-426614174000", // RFC v1
  "0190a5e5-2c3a-7000-8000-123456789abc", // v7
  "ABCDEF01-2345-4678-89AB-CDEF01234567", // upper case
  "00000000-0000-0000-0000-000000000000", // nil
  "ffffffff-ffff-ffff-ffff-ffffffffffff", // max
  "11111111-1111-1111-1111-111111111111", // not RFC-valid (version 1, variant 0): accepted today
  "12345678-1234-1234-1234-123456789012", // not RFC-valid variant: accepted today
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", // not RFC-valid: accepted today
  "12345678-1234-1234-8234-12345678901f", // variant ok, version 1
  "6ba7b810-9dad-02d3-80b4-00c04fd430c8", // version 0: accepted today
];

export const UUID_REJECT: readonly string[] = [
  "",
  "not-a-uuid",
  "00000000000040008000000000000001", // no hyphens
  "{00000000-0000-4000-8000-000000000001}", // braces
  "00000000-0000-4000-8000-00000000000", // short
  "00000000-0000-4000-8000-0000000000012", // long
  "00000000-0000-4000-8000-00000000000g", // non-hex
  " 00000000-0000-4000-8000-000000000001", // leading space
  "00000000-0000-4000-8000-000000000001 ", // trailing space
  "00000000-0000-4000-8000-000000000001\n", // trailing newline
  "urn:uuid:00000000-0000-4000-8000-000000000001",
];

/** Sign-in e-mail shapes (loginEmailString: e-mail form, at most 254 characters). */
export const EMAIL_ACCEPT: readonly string[] = [
  "a@b.co",
  "first.last@example.com",
  "FIRST.LAST@EXAMPLE.COM",
  "user+tag@sub.example.co.ke",
  "o'brien@example.com",
  "x_y-z@example-domain.org",
  "admin@localhost.localdomain",
  `${"a".repeat(64)}@${"b".repeat(60)}.com`,
];

export const EMAIL_REJECT: readonly string[] = [
  "",
  "plain",
  "@example.com",
  "user@",
  "user@@example.com",
  "user name@example.com",
  "user@exa mple.com",
  ".user@example.com",
  "user.@example.com",
  "us..er@example.com",
  "user@-example.com",
  "user@example",
  "a&b@example.com", // rejected by Zod 3.25.76 today; pinned as rejected
  `${"a".repeat(250)}@x.com`, // over 254 characters in total
];
