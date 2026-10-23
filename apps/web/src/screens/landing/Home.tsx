import { useEffect, useState, type ReactNode } from 'react';
import './Home.css';

// const iconPaths: Record<string, ReactNode> = {
//   users: (
//     <>
//       <circle cx="10" cy="8" r="3" />
//       <path d="M3.5 19c.4-3.4 2.6-5.2 6.5-5.2s6.1 1.8 6.5 5.2" />
//       <path d="M16 5.4a3 3 0 0 1 0 5.8M18 14c2 .7 3.1 2.3 3.4 5" />
//     </>
//   ),
//   chart: (
//     <>
//       <path d="M4 20V12h4v8H4Zm6 0V7h4v13h-4Zm6 0V3h4v17h-4Z" />
//     </>
//   ),
//   document: (
//     <>
//       <path d="M6 3h8l5 5v13H6V3Z" />
//       <path d="M14 3v5h5M9 13h6m-6 4h6" />
//     </>
//   ),
//   payment: (
//     <>
//       <rect x="3" y="6" width="18" height="13" rx="2" />
//       <path d="M3 10h18m-14 5h3m7 4v2M7 19v2" />
//       <circle cx="15.5" cy="14.5" r="2" />
//     </>
//   ),
//   calendar: (
//     <>
//       <rect x="3" y="5" width="18" height="16" rx="2" />
//       <path d="M7 3v4m10-4v4M3 10h18m-14 4h2m3 0h2m3 0h1m-11 4h2" />
//     </>
//   ),
//   bus: (
//     <>
//       <path d="M5 17V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v11" />
//       <path d="M5 11h14M8 15h.01M16 15h.01M7 20v-3m10 3v-3M5 17h14" />
//     </>
//   ),
// };

// const orbitFeatures = [
//   { name: 'Attendance', icon: 'calendar', className: 'attendance' },
//   { name: 'Bus tracking', icon: 'bus', className: 'bus-tracking' },
//   { name: 'Kenyan curriculum', icon: 'document', className: 'curriculum' },
//   { name: 'Fees payment', icon: 'payment', className: 'fees-payment' },
//   { name: 'Communication', icon: 'users', className: 'communication' },
// ];



// function Icon({ name, className = '' }: { name: string; className?: string }) {
//   return (
//     <svg
//       aria-hidden="true"
//       className={className}
//       viewBox="0 0 24 24"
//       fill="none"
//       stroke="currentColor"
//       strokeWidth="1.8"
//       strokeLinecap="round"
//       strokeLinejoin="round"
//     >
//       {iconPaths[name]}
//     </svg>
//   );
// }

function GraduationCap() {
  return (
    <svg
      aria-hidden="true"
      className="orbit-cap"
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth="5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m10 39 40-22 40 22-40 22L10 39Z" />
      <path d="m25 48 1 23 24 14 25-14-1-23M78 49v20" />
      <path d="m46 42 16-9" />
      <path d="M24 48v15" />
    </svg>
  );
}

// function OrbitVisual() {
//   return (
//     <div className="orbit-visual" aria-hidden="true">
//       <div className="orbit-ring orbit-ring-outer" />
//       {/* <div className="orbit-ring orbit-ring-inner" /> */}
//       <div className="orbit-center">
//         <GraduationCap />
//       </div>
//       <div className="orbit-track">
//         {orbitFeatures.map((feature) => (
//           <div
//             className={`orbit-item orbit-item-${feature.className}`}
//             key={feature.name}
//           >
//             <div className="orbit-card">
//               <Icon name={feature.icon} />
//               <span>{feature.name}</span>
//             </div>
//           </div>
//         ))}
//       </div>
//     </div>
//   );
// }

/** Site header and navigation. Rendered by Landing, outside <main>, so it is the page's banner landmark. */
export function SiteHeader() {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 10);
    handleScroll();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  return (
    <div className={`site-header-bar${isScrolled ? ' is-scrolled' : ''}`}>
      <header className="site-header">
        <a className="brand" href="/" aria-label="BloomEd home">
          <span className="brand-mark" aria-hidden="true">
            <GraduationCap />
          </span>
          <span>BloomEd</span>
        </a>

        <nav className="main-nav" aria-label="Main navigation">
          <a href="/">Home</a>
          <a href="#features">Features</a>
          <a href="#who-its-for">Who it's for</a>
          <a href="#contact">Contact</a>
        </nav>

        <div className="header-actions">
          <a className="login-link" href="/signin">Login</a>
          <a className="header-demo-link" href="#contact">Get Started</a>
        </div>
      </header>
    </div>
  );
}

function Home() {
  return (
    <div className="home-page">
      <section className="home-hero">
        <video
          className="hero-video"
          src="/images/WhatsApp%20Video%202026-10-16%20at%2011.41.42.mp4"
          autoPlay
          muted
          loop
          playsInline
          aria-hidden="true"
        />
        <div className="hero-content">
          <div className="hero-copy">
            <h1>School management system for Kenya</h1>
            <p>
              BloomEd brings fees, attendance, CBE and 8-4-4 results, bus tracking
              and parent communication into one school management system, so your
              team spends less time on admin.
            </p>
            <div className="hero-actions">
              <a className="button button-primary" href="#contact">
                Get Started
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12h14m-6-6 6 6-6 6" />
                </svg>
              </a>
              <a className="button button-secondary" href="#features">
                Learn More
              </a>
            </div>
          </div>

          {/* <OrbitVisual /> */}
        </div>
      </section>
      <div className="dashboard-preview">
        <div className="screenshot-frame">
          <img
            src="/images/adminn-dashboard.webp"
            alt="BloomEd school management system dashboard showing attendance by class, fees collected and learner numbers"
            width={1917}
            height={946}
            decoding="async"
            loading="lazy"
          />
        </div>
      </div>
    </div>
  );
}

export default Home;
