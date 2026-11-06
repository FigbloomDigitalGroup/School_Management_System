import { assertEquals } from "jsr:@std/assert@1";
import { firstName, pushFor, type SignOutRow } from "./plan.ts";

const base: SignOutRow = {
  id: "o1", tenant_id: "t1", student_id: "s1", student_name: "Amani Wanjiru Otieno", signed_out_local: "10:45:00",
  collected_by_name: "Jane Wanjiru", collected_by_relationship: "Aunt", recorded_by: "u1", voided_at: null, parent_pushed_at: null,
};

Deno.test("the parent is told who, when and who collected, by the learner's first name", () => {
  assertEquals(pushFor(base), {
    title: "Amani was signed out early",
    body: "Signed out at 10:45, collected by Jane Wanjiru (Aunt).",
  });
});

Deno.test("nothing is owed for a voided sign-out or one the parents were already told about", () => {
  assertEquals(pushFor({ ...base, voided_at: "2026-11-06T08:00:00Z" }), null);
  assertEquals(pushFor({ ...base, parent_pushed_at: "2026-11-06T07:50:00Z" }), null);
});

Deno.test("the push never carries an ID number or phone: the row it is built from has none", () => {
  const text = JSON.stringify(pushFor(base));
  assertEquals(/id_number|phone|\d{7,}/i.test(text), false);
});

Deno.test("a learner with no name is 'Your child'", () => {
  assertEquals(firstName("   "), "Your child");
  assertEquals(firstName("Amani"), "Amani");
});
