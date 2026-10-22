import { PageHead } from "../../components/ConsoleShell";
import { MyAccountFields } from "../../components/MyAccountFields";

/** The principal's own record — distinct from School settings, which is
 *  about the school (term dates, fees, crest), not the person signed in. */
export function AdminAccount() {
  return (
    <>
      <PageHead eyebrow="Account" title="My account" blurb="Your own name, phone, and photo — nobody else's." />
      <div className="px-7 py-6">
        <MyAccountFields />
      </div>
    </>
  );
}
