import { useEffect, useState, type ReactNode } from 'react';
import './Audiences.css';

const audienceIcons: Record<string, ReactNode> = {
  school: (
    <>
      <path d="M3 21h18M5 21V10l7-5 7 5v11" />
      <path d="M10 21v-5h4v5M9 11h.01M15 11h.01" />
    </>
  ),
  teacher: (
    <>
      <circle cx="8" cy="7" r="3" />
      <path d="M2.5 20c.4-3.6 2.3-5.6 5.5-5.6 1.6 0 2.9.5 3.8 1.5" />
      <path d="M12 4h9v9h-6M15 13l-2 3" />
    </>
  ),
  parent: (
    <>
      <circle cx="8" cy="6" r="2.6" />
      <circle cx="16.5" cy="9" r="2" />
      <path d="M3.5 20c.3-4 2-6.4 4.5-6.4s4.2 2.4 4.5 6.4M13.5 20c.2-2.9 1.3-4.6 3-4.6s2.8 1.7 3 4.6" />
    </>
  ),
  student: (
    <>
      <path d="m2 9 10-5 10 5-10 5L2 9Z" />
      <path d="M6 11v5c1.7 1.5 3.7 2.2 6 2.2s4.3-.7 6-2.2v-5M22 9v6" />
    </>
  ),
  driver: (
    <>
      <path d="M5 17V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11" />
      <path d="M5 11h14M8 15h.01M16 15h.01M7 20v-3m10 3v-3M5 17h14" />
    </>
  ),
  group: (
    <>
      <path d="M3 21h18M4 21V8h6v13M14 21V4h6v17" />
      <path d="M6.5 11h1m-1 3h1m-1 3h1m9-10h1m-1 3h1m-1 3h1m-1 3h1" />
    </>
  ),
  college: (
    <>
      <path d="M3 9 12 4l9 5H3Z" />
      <path d="M5 9v9m4.7-9v9m4.6-9v9M19 9v9M3 21h18M4 18h16" />
    </>
  ),
};

const audiences = [
  {
    key: 'admin',
    label: 'School Admin',
    icon: 'school',
    heading: 'For school admins',
    intro: 'Run the whole school from one dashboard, from admissions to fee collection.',
    features: [
      { title: 'Quick setup', text: 'Import all learners from a spreadsheet in one go.' },
      { title: 'Fee collection', text: 'Track balances and confirm payments in one place.' },
      { title: 'Staff and leave', text: 'Approve leave and assign substitutes for each lesson.' },
      { title: 'Reports', text: 'See attendance, fees and performance at a glance.' },
    ],
    platforms: ['Web'],
  },
  {
    key: 'teacher',
    label: 'Teacher',
    icon: 'teacher',
    heading: 'For teachers',
    intro: "Everything you need to manage your classroom, even when the internet isn't reliable.",
    features: [
      { title: 'Attendance', text: 'Take attendance in 60 seconds.' },
      { title: 'Exam marks', text: 'Enter marks easily.' },
      { title: 'CBE Assessment', text: 'Add levels and comments.' },
      { title: 'Timetable', text: "Know exactly what's next." },
    ],
    platforms: ['Web', 'Android'],
  },
  {
    key: 'parent',
    label: 'Parent',
    icon: 'parent',
    heading: 'For parents',
    intro: 'Everything about your child, in one place.',
    features: [
      { title: 'Fee balance', text: 'See what you owe and how to pay.' },
      { title: 'Results', text: 'Follow your child’s grades and CBE levels.' },
      { title: 'Bus tracking', text: 'Watch the school bus arrive on a live map.' },
      { title: 'Notices', text: 'Get school announcements as they happen.' },
    ],
    platforms: ['Web', 'Android'],
  },
  {
    key: 'student',
    label: 'Student',
    icon: 'student',
    heading: 'For students',
    intro: 'Stay on top of classes, results and school news.',
    features: [
      { title: 'Timetable', text: 'Know which lesson is next.' },
      { title: 'Results', text: 'See your marks once they are published.' },
      { title: 'Messages', text: 'Hear from your class teacher directly.' },
      { title: 'Notices', text: 'Never miss a school announcement.' },
    ],
    platforms: ['Android'],
  },
  {
    key: 'driver',
    label: 'Driver',
    icon: 'driver',
    heading: 'For drivers',
    intro: 'Share your route so parents always know where the bus is.',
    features: [
      { title: 'Live location', text: 'Share the bus position with one tap.' },
      { title: 'Route stops', text: 'See every stop in order.' },
      { title: 'Learner list', text: 'Know who to pick up at each stop.' },
      { title: 'Delays', text: 'Let parents know when you are running late.' },
    ],
    platforms: ['Android'],
  },
  {
    key: 'group',
    label: 'School Group',
    icon: 'group',
    heading: 'For school groups',
    intro: 'Oversee every school in your group from one account.',
    features: [
      { title: 'All schools', text: 'Switch between schools in one click.' },
      { title: 'Group reports', text: 'Compare fees and results across schools.' },
      { title: 'Shared setup', text: 'Reuse fee structures and settings.' },
      { title: 'Access control', text: 'Decide who sees which school.' },
    ],
    platforms: ['Web'],
  },
  {
    key: 'college',
    label: 'College',
    icon: 'college',
    heading: 'For colleges',
    intro: 'Manage courses, students and fees for your college.',
    features: [
      { title: 'Courses', text: 'Organise programmes, units and intakes.' },
      { title: 'Fees', text: 'Track payments for every student.' },
      { title: 'Results', text: 'Record and publish unit results.' },
      { title: 'Communication', text: 'Reach students and lecturers instantly.' },
    ],
    platforms: ['Web', 'Android'],
  },
];

function AudienceIcon({ name }: { name: string }) {
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
      {audienceIcons[name]}
    </svg>
  );
}

function PlatformIcon({ name }: { name: string }) {
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
      {name === 'Web' ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z" />
        </>
      ) : (
        <>
          <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
          <path d="M11 18.5h2" />
        </>
      )}
    </svg>
  );
}

const HASH_PREFIX = '#who-its-for-';

function Audiences() {
  const [activeAudience, setActiveAudience] = useState(0);

  // Links like "#who-its-for-teacher" open that role's tab and scroll to the section.
  useEffect(() => {
    const openFromHash = () => {
      const hash = window.location.hash;
      if (!hash.startsWith(HASH_PREFIX)) return;
      const index = audiences.findIndex((audience) => audience.key === hash.slice(HASH_PREFIX.length));
      if (index === -1) return;
      setActiveAudience(index);
      document.getElementById('who-its-for')?.scrollIntoView();
      // Settle on the plain section anchor so clicking the same link again is a hash change again.
      window.history.replaceState(null, '', '#who-its-for');
    };
    openFromHash();
    window.addEventListener('hashchange', openFromHash);
    return () => window.removeEventListener('hashchange', openFromHash);
  }, []);

  return (
    <section className="audiences" id="who-its-for">
      <div className="audiences-inner">
        <div className="audiences-header">
          <h2 className='pt-3 pb-4 text-center font-bold text-[#FF9400] text-3xl' >Who it's for</h2>
          <h3>One platform. Every role.</h3>
          <p>
            Give school administrators, teachers, parents, students and drivers
            the tools they need.
          </p>
        </div>

        <div className="audience-tabs" role="tablist" aria-label="Who it's for">
          {audiences.map((audience, index) => (
            <button
              aria-controls={`audience-panel-${audience.key}`}
              aria-selected={activeAudience === index}
              className={`audience-tab${activeAudience === index ? ' is-active' : ''}`}
              id={`audience-tab-${audience.key}`}
              key={audience.key}
              onClick={() => setActiveAudience(index)}
              role="tab"
              type="button"
            >
              <span className="audience-tab-icon">
                <AudienceIcon name={audience.icon} />
              </span>
              {audience.label}
            </button>
          ))}
        </div>

        {/* Every role's panel is in the page (inactive ones are `hidden`) so search engines
            can read all of them, not just whichever tab happens to be open. */}
        {audiences.map((audience, index) => (
          <div
            aria-labelledby={`audience-tab-${audience.key}`}
            className="audience-panel"
            hidden={activeAudience !== index}
            id={`audience-panel-${audience.key}`}
            key={audience.key}
            role="tabpanel"
          >
            <div className="audience-panel-heading">
              <span className="audience-panel-icon">
                <AudienceIcon name={audience.icon} />
              </span>
              <span>{audience.heading}</span>
            </div>
            <p className="audience-panel-intro">{audience.intro}</p>

            <ul className="audience-features">
              {audience.features.map((feature) => (
                <li className="audience-feature" key={feature.title}>
                  <h3>
                    <span aria-hidden="true">✓</span>
                    {feature.title}
                  </h3>
                  <p>{feature.text}</p>
                </li>
              ))}
            </ul>

            <div className="audience-platforms">
              <span>Available on</span>
              <div>
                {audience.platforms.map((platform) => (
                  <span className="audience-platform" key={platform}>
                    <PlatformIcon name={platform} />
                    {platform}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default Audiences;
