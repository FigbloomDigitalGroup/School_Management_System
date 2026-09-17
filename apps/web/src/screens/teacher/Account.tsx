import { PageHead } from "../../components/ConsoleShell";
import { MyAccountFields } from "../../components/MyAccountFields";

export function TeacherAccount() {
  return (
    <>
      <PageHead eyebrow="Account" title="My account" blurb="Your own name, phone, and photo — nobody else's." />
      <div className="px-7 py-6">
        <MyAccountFields />
      </div>
    </>
  );
}
