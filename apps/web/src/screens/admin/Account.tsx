import { PageHead } from "../../components/ConsoleShell";
import { AccountSections, accountBlurb } from "../../components/account/AccountSections";

/** The principal's own record — distinct from School settings, which is
 *  about the school (term dates, fees, crest), not the person signed in. */
export function AdminAccount() {
  return (
    <>
      <PageHead eyebrow="Account" title="My account" blurb={accountBlurb()} />
      <div className="px-7 py-6">
        <AccountSections />
      </div>
    </>
  );
}
