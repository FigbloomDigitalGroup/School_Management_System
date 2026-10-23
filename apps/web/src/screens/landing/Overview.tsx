import type { ReactNode } from 'react';
import './Overview.css';

const overviewIcons: Record<string, ReactNode> = {
  student: (
    <>
      <path d="m2 9 10-5 10 5-10 5L2 9Z" />
      <path d="M6 11v5c1.7 1.5 3.7 2.2 6 2.2s4.3-.7 6-2.2v-5M22 9v6" />
    </>
  ),
  fees: (
    <>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10.5h18M7 15h3" />
    </>
  ),
  attendance: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 3v4m10-4v4M3 10h18m-14 4h2m3 0h2m3 0h1m-11 4h2" />
    </>
  ),
  teacher: (
    <>
      <circle cx="8" cy="7" r="3" />
      <path d="M2.5 20c.4-3.6 2.3-5.6 5.5-5.6 1.6 0 2.9.5 3.8 1.5" />
      <path d="M12 4h9v9h-6M15 13l-2 3" />
    </>
  ),
  communication: (
    <>
      <path d="M4 20l1.3-3.9A8 8 0 1 1 8 19.1L4 20Z" />
      <path d="M9 10h.01M12 10h.01M15 10h.01" />
    </>
  ),
  bus: (
    <>
      <path d="M5 17V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11" />
      <path d="M5 11h14M8 15h.01M16 15h.01M7 20v-3m10 3v-3M5 17h14" />
    </>
  ),
  curriculum: (
    <>
      <path d="M6 3h8l5 5v13H6V3Z" />
      <path d="M14 3v5h5M9 13h6m-6 4h6" />
    </>
  ),
  reports: <path d="M4 20V12h4v8H4Zm6 0V7h4v13h-4Zm6 0V3h4v17h-4Z" />,
};

// Each card links to the feature tab (or role tab) that covers it in more detail.
const capabilities = [
  {
    icon: 'student',
    title: 'Student management',
    href: '#features-less-admin-work',
    text: "Keep every learner's record in one place, with classes and boarding or day status. Import a whole school from a spreadsheet, with errors flagged before anything is saved.",
  },
  {
    icon: 'fees',
    title: 'School fees management',
    href: '#features-fees',
    text: 'Set fee structures by year group and by boarding or day. Parents see what they owe and how to pay, upload proof of payment, and the bursar confirms it.',
  },
  {
    icon: 'attendance',
    title: 'Attendance management',
    href: '#features-attendance',
    text: 'Teachers record class attendance in about a minute. Administrators see which classes have submitted and where absences need follow-up.',
  },
  {
    icon: 'teacher',
    title: 'Teacher management',
    href: '#who-its-for-admin',
    text: 'Assign class teachers, share timetables and handle leave requests in the app. When a teacher is away, the admin assigns a substitute for each affected lesson.',
  },
  {
    icon: 'communication',
    title: 'Parent communication',
    href: '#features-communication',
    text: "Send announcements to the whole school, all parents, one year group or one class. Messages arrive in the app with phone notifications, and teachers can message their class's parents.",
  },
  {
    icon: 'bus',
    title: 'School bus tracking',
    href: '#features-bus-tracking',
    text: 'Parents watch the bus on a live map with their child\'s stop marked and get updates like "on its way" or "running late". Drivers share their route from a phone.',
  },
  {
    icon: 'curriculum',
    title: 'CBE and 8-4-4 assessment',
    href: '#features-kenyan-curriculum',
    text: 'Assess CBE from PP1 to Grade 12 with KICD learning areas and rubrics, or record 8-4-4 marks for Forms 1 to 4 on the KCSE 12-point scale.',
  },
  {
    icon: 'reports',
    title: 'Reports and administration',
    href: '#features-less-admin-work',
    text: 'See attendance, fee collection, academic performance and CBE levels at a glance. School groups can oversee every school from one account.',
  },
];

function OverviewIcon({ name }: { name: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {overviewIcons[name]}
    </svg>
  );
}

function Overview() {
  return (
    <section className="overview" id="overview">
      <div className="overview-inner">
        <div className="overview-header">
          <h2 className='pt-3 pb-4 text-center font-bold text-[#FF9400] text-3xl'>What is a school management system?</h2>
          <h3>Everything your school runs on, in one place.</h3>
          <p>
            A school management system is software that runs a school's day-to-day
            administration in one place: learner records, fees, attendance, exam
            results, staff and communication with parents. Instead of paper registers
            and scattered spreadsheets, everyone works from the same up-to-date information.
          </p>
          <p>
            BloomEd is a school management system built for Kenyan schools. It supports
            both the CBE and 8-4-4 curricula, keeps working on weak networks, and gives
            administrators, teachers, parents, students and drivers one simple place to
            work, whether you run a single school, a group of schools or a college.
          </p>
        </div>

        <ul className="overview-grid">
          {capabilities.map((capability) => (
            <li className="overview-card" key={capability.title}>
              <span className="overview-icon">
                <OverviewIcon name={capability.icon} />
              </span>
              <h3>
                <a href={capability.href}>{capability.title}</a>
              </h3>
              <p>{capability.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default Overview;
