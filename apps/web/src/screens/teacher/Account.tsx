import { PageHead } from "../../components/ConsoleShell";
import { accountCapabilities } from "@figbloom/shared";
import { AccountSections, accountBlurb } from "../../components/account/AccountSections";
import { CallContacts } from "../../components/calls/CallContacts";

export function TeacherAccount() {
  return (
    <>
      <PageHead eyebrow="Account" title="My account" blurb={accountBlurb()} />
      <div className="px-7 py-6">
        <AccountSections />
        {accountCapabilities().calls && <CallContacts title="Call someone" blurb="Colleagues, and the parents of learners you teach. Voice or video, in the app." />}
      </div>
    </>
  );
}
