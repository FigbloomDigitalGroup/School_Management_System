import { PageHead } from "../../components/ConsoleShell";
import { MyAccountFields } from "../../components/MyAccountFields";
import { CallContacts } from "../../components/calls/CallContacts";

export function TeacherAccount() {
  return (
    <>
      <PageHead eyebrow="Account" title="My account" blurb="Your own name, phone, and photo — nobody else's." />
      <div className="px-7 py-6">
        <MyAccountFields />
        <CallContacts title="Call someone" blurb="Colleagues, and the parents of learners you teach. Voice or video, in the app." />
      </div>
    </>
  );
}
