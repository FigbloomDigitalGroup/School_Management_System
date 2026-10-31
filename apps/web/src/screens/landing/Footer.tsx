import type { ReactNode } from 'react';
import contactDetails, { whatsappLink } from './contactDetails';
import { CallLink, EmailLink } from './ContactLinks';
import './Footer.css';

const footerLinks = [
  {
    heading: 'Product',
    links: [
      { label: 'Features', href: '#features' },
      { label: 'School fees management', href: '#features-fees' },
      { label: 'Attendance management', href: '#features-attendance' },
      { label: 'School bus tracking', href: '#features-bus-tracking' },
      { label: "Who it's for", href: '#who-its-for' },
      { label: 'Why schools choose us', href: '#why-us' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'Request Demo', href: '#contact' },
      { label: 'Contact', href: '#contact' },
      { label: 'FAQ', href: '#faq' },
      { label: 'Privacy policy', href: '/privacy' },
      { label: 'Delete your data', href: '/delete-account.html' },
      { label: 'Login', href: '/signin' },
    ],
  },
];

const footerIcons: Record<string, ReactNode> = {
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  phone: (
    <path d="M5 4h3.5l1.5 4.5-2 1.2a11 11 0 0 0 6.3 6.3l1.2-2 4.5 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" />
  ),
  chat: (
    <>
      <path d="M4 20l1.3-3.9A8 8 0 1 1 8 19.1L4 20Z" />
      <path d="M9 10h.01M12 10h.01M15 10h.01" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  up: <path d="M12 19V5m-6 6 6-6 6 6" />,
};

function FooterIcon({ name }: { name: string }) {
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
      {footerIcons[name]}
    </svg>
  );
}

function GraduationCap() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      fill="none"
      stroke="currentColor"
      strokeWidth="6"
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

function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <div className="footer-top">
          <div className="footer-brand">
            <a className="footer-logo" href="/" aria-label="BloomEd home">
              <span className="footer-logo-mark">
                <GraduationCap />
              </span>
              BloomEd
            </a>
            <p>
              The school management system for Kenyan schools. Fees, attendance,
              CBE assessment, bus tracking and communication in one place.
            </p>
            <a className="footer-cta" href="#contact">Request Demo</a>
          </div>

          {footerLinks.map((group) => (
            <nav className="footer-column" aria-label={group.heading} key={group.heading}>
              <h3>{group.heading}</h3>
              <ul>
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}

          <div className="footer-column">
            <h3>Get in touch</h3>
            <ul className="footer-contact">
              <li>
                <FooterIcon name="mail" />
                <EmailLink>{contactDetails.email}</EmailLink>
              </li>
              <li>
                <FooterIcon name="phone" />
                <CallLink>{(copied) => (copied ? 'Number copied!' : contactDetails.phone)}</CallLink>
              </li>
              <li>
                <FooterIcon name="chat" />
                <a href={whatsappLink} rel="noreferrer" target="_blank">WhatsApp {contactDetails.whatsapp}</a>
              </li>
              <li>
                <FooterIcon name="pin" />
                <span>{contactDetails.location}</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="footer-bottom">
          <p>© {year} BloomEd. All rights reserved.</p>
          <a className="footer-top-link" href="#top">
            <FooterIcon name="up" />
          </a>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
