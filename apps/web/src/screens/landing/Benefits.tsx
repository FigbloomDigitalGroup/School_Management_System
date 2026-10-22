import type { ReactNode } from 'react';
import './Benefits.css';

const benefitIcons: Record<string, ReactNode> = {
  brand: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2Z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 9-9M16 7l2.5 2.5M18.5 4.5 21 7" />
    </>
  ),
  signal: (
    <>
      <path d="M4 20v-3M9 20v-7M14 20V9M19 20V4" />
    </>
  ),
  live: (
    <>
      <circle cx="12" cy="12" r="2.5" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
    </>
  ),
  access: (
    <>
      <circle cx="12" cy="4.5" r="1.8" />
      <path d="M5 8.5c2.3.7 4.6 1 7 1s4.7-.3 7-1M12 9.5V14m0 0-3 6.5M12 14l3 6.5" />
    </>
  ),
  phone: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
    </>
  ),
  grow: (
    <>
      <path d="M3 17 9 11l4 4 8-8" />
      <path d="M15 7h6v6" />
    </>
  ),
};

const benefits = [
  { icon: 'brand', title: 'Your school, your look', text: 'Your logo, colours and name on every screen.' },
  { icon: 'lock', title: 'Private by design', text: 'Each school’s data stays its own.' },
  { icon: 'key', title: 'Easy sign-in', text: 'Log in with a phone number in seconds.' },
  { icon: 'signal', title: 'Works on weak networks', text: 'Keeps working when the signal drops.' },
  { icon: 'live', title: 'Live updates', text: 'Changes show up for everyone instantly.' },
  { icon: 'access', title: 'Accessible to everyone', text: 'Clear text, contrast and simple layouts.' },
  { icon: 'phone', title: 'Runs on everyday phones', text: 'Light enough for low-cost Android devices.' },
  { icon: 'grow', title: 'Ready to grow', text: 'From one school to a whole group.' },
];

function BenefitIcon({ name }: { name: string }) {
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
      {benefitIcons[name]}
    </svg>
  );
}

function Benefits() {
  return (
    <section className="benefits" id="why-us">
      <div className="benefits-inner">
        <div className="benefits-header">
          <h1 className='pt-3 pb-4 text-center font-bold text-[#FF9400] text-3xl'>Why schools choose us</h1>
          <h2>Built for how schools really work.</h2>
        </div>

        <ul className="benefits-grid">
          {benefits.map((benefit) => (
            <li className="benefit-card" key={benefit.title}>
              <span className="benefit-icon">
                <BenefitIcon name={benefit.icon} />
              </span>
              <h3>{benefit.title}</h3>
              <p>{benefit.text}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export default Benefits;
