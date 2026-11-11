import { useEffect, useState, type ReactNode } from 'react';
import './Home.css';


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
        <a className="brand" href="/" aria-label="Figbloom School Management home">
          <img className="brand-logo brand-logo-light" src="/figbloom-logo-light.svg" alt="" width="218" height="64" />
          <img className="brand-logo brand-logo-dark" src="/figbloom-logo.svg" alt="" width="218" height="64" />
        </a>

        <nav className="main-nav" aria-label="Main navigation">
          <a href="/">Home</a>
          <a href="#features">Features</a>
          <a href="#who-its-for">Who it's for</a>
          <a href="#contact">Contact</a>
        </nav>

        <div className="header-actions">
          <a className="login-link" href="/signin">Login</a>
          <a className="header-demo-link" href="/signup">Get Started</a>
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
              Figbloom School Management brings fees, attendance, CBE and 8-4-4 results, bus tracking
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
            alt="Figbloom School Management dashboard showing attendance by class, fees collected and learner numbers"
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
