import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import contactDetails, { emailLink, whatsappLink } from './contactDetails';
import { CallLink, CopyEmailButton, EmailLink } from './ContactLinks';
import './Contact.css';

const contactIcons: Record<string, ReactNode> = {
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  phone: (
    <>
      <path d="M5 4h3.5l1.5 4.5-2 1.2a11 11 0 0 0 6.3 6.3l1.2-2 4.5 1.5V19a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z" />
    </>
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
};

const demoSteps = [
  'A 30-minute walkthrough tailored to your school',
  'Answers on fees, CBE assessment and bus tracking',
  'Help moving your learner records across',
];

const roles = ['School owner / Director', 'Principal / Head teacher', 'Bursar / Accounts', 'Teacher', 'Parent', 'Other'];
const schoolSizes = ['Under 200 learners', '200 – 500 learners', '500 – 1,000 learners', 'Over 1,000 learners', 'A group of schools'];

const emptyForm = {
  name: '',
  email: '',
  phone: '',
  school: '',
  role: '',
  size: '',
  message: '',
};

function ContactIcon({ name }: { name: string }) {
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
      {contactIcons[name]}
    </svg>
  );
}

function Contact() {
  const [form, setForm] = useState(emptyForm);
  const [isSent, setIsSent] = useState(false);

  const handleChange = (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // No backend yet, so hand the request to Gmail, ready to send.
    const subject = `Demo request: ${form.school}`;
    const body = [
      `Name: ${form.name}`,
      `Email: ${form.email}`,
      `Phone: ${form.phone}`,
      `School: ${form.school}`,
      `Role: ${form.role}`,
      `School size: ${form.size}`,
      '',
      form.message,
    ].join('\n');

    window.open(emailLink(subject, body), '_blank', 'noreferrer');
    setIsSent(true);
  };

  const handleReset = () => {
    setForm(emptyForm);
    setIsSent(false);
  };

  return (
    <section className="contact" id="contact">
      <div className="contact-inner">
        <div className="contact-header">
          <h2 className='pt-3 pb-4 text-center font-bold text-[#FF9400] text-3xl'>Contact us</h2>
          <h3>Use BloomEd in your school.</h3>
          <p>Book a free demo or ask us anything. We usually reply immediately.</p>
        </div>

        <div className="contact-layout">
          <aside className="contact-info">
            <h3>What to expect</h3>
            <ul className="contact-steps">
              {demoSteps.map((step) => (
                <li key={step}>
                  <span aria-hidden="true">✓</span>
                  {step}
                </li>
              ))}
            </ul>

            <div className="contact-methods">
              <EmailLink className="contact-method">
                <span className="contact-method-icon"><ContactIcon name="mail" /></span>
                <span>
                  <small>Email</small>
                  {contactDetails.email}
                </span>
              </EmailLink>
              <CopyEmailButton className="contact-copy" />
              <CallLink className="contact-method">
                {(copied: boolean) => (
                  <>
                    <span className="contact-method-icon"><ContactIcon name="phone" /></span>
                    <span>
                      <small>{copied ? 'Number copied!' : 'Call'}</small>
                      {contactDetails.phone}
                    </span>
                  </>
                )}
              </CallLink>
              <a
                className="contact-method"
                href={whatsappLink}
                rel="noreferrer"
                target="_blank"
              >
                <span className="contact-method-icon"><ContactIcon name="chat" /></span>
                <span>
                  <small>WhatsApp</small>
                  Chat with us
                </span>
              </a>
              <div className="contact-method">
                <span className="contact-method-icon"><ContactIcon name="pin" /></span>
                <span>
                  <small>Office</small>
                  {contactDetails.location}
                </span>
              </div>
            </div>
          </aside>

          <div className="contact-card">
            {isSent ? (
              <div className="contact-success" role="status">
                <span className="contact-success-icon" aria-hidden="true">✓</span>
                <h3>Thanks, {form.name.split(' ')[0]}!</h3>
                <p>
                  Gmail should now be open in a new tab with your request
                  ready to send. Just press Send, and we'll get back to you to set up your demo.
                </p>
                <button className="contact-button contact-button-ghost" onClick={handleReset} type="button">
                  Send another request
                </button>
              </div>
            ) : (
              <form className="contact-form" onSubmit={handleSubmit}>
                <div className="contact-field">
                  <label htmlFor="contact-name">Full name</label>
                  <input
                    autoComplete="name"
                    id="contact-name"
                    name="name"
                    onChange={handleChange}
                    required
                    type="text"
                    value={form.name}
                  />
                </div>

                <div className="contact-field">
                  <label htmlFor="contact-school">School name</label>
                  <input
                    autoComplete="organization"
                    id="contact-school"
                    name="school"
                    onChange={handleChange}
                    required
                    type="text"
                    value={form.school}
                  />
                </div>

                <div className="contact-field">
                  <label htmlFor="contact-email">Email</label>
                  <input
                    autoComplete="email"
                    id="contact-email"
                    name="email"
                    onChange={handleChange}
                    required
                    type="email"
                    value={form.email}
                  />
                </div>

                <div className="contact-field">
                  <label htmlFor="contact-phone">Phone number</label>
                  <input
                    autoComplete="tel"
                    id="contact-phone"
                    inputMode="tel"
                    name="phone"
                    onChange={handleChange}
                    placeholder="07XX XXX XXX"
                    required
                    type="tel"
                    value={form.phone}
                  />
                </div>

                <div className="contact-field">
                  <label htmlFor="contact-role">Your role</label>
                  <select id="contact-role" name="role" onChange={handleChange} required value={form.role}>
                    <option disabled value="">Select your role</option>
                    {roles.map((role) => (
                      <option key={role}>{role}</option>
                    ))}
                  </select>
                </div>

                <div className="contact-field">
                  <label htmlFor="contact-size">School size</label>
                  <select id="contact-size" name="size" onChange={handleChange} required value={form.size}>
                    <option disabled value="">Select size</option>
                    {schoolSizes.map((size) => (
                      <option key={size}>{size}</option>
                    ))}
                  </select>
                </div>

                <div className="contact-field contact-field-full">
                  <label htmlFor="contact-message">
                    Message <span className="contact-optional">(optional)</span>
                  </label>
                  <textarea
                    id="contact-message"
                    name="message"
                    onChange={handleChange}
                    placeholder="Tell us what you'd like to see in the demo"
                    rows={4}
                    value={form.message}
                  />
                </div>

                <button className="contact-button contact-field-full" type="submit">
                  Request Demo
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
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default Contact;
