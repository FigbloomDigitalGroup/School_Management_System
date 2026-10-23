import { useEffect, useState } from 'react';
import './Features.css'

const featureTabs = [
  {
    // `slug` is the deep-link anchor: "#features-fees" opens the Fees tab (see Overview and Footer links).
    slug: 'attendance',
    label: 'Attendance',
    title: 'Student attendance management',
    image: '/images/adminn-dashboard.webp',
    alt: 'BloomEd dashboard showing attendance by class and which classes still need to submit their register',
    description: 'Make attendance easier to record, review, and follow up.',
    points: [
      'Record class attendance and see submissions at a glance.',
      'Identify absences and patterns that may need attention.',
      'Keep teachers and school teams aligned on follow-up.',
    ],
  },
  {
    slug: 'bus-tracking',
    label: 'Bus Tracking',
    title: 'School bus tracking',
    image: '/images/Fleet.webp',
    alt: 'School bus tracking in BloomEd: a live map of a Nairobi bus route with the vehicle, route and driver details',
    description: 'Know exactly where the school bus is.',
    points: [
      'Parents see their child\'s bus on a live map, with the child\'s stop marked.',
      'Parents get updates like "on its way, about 7:42", "1 km away", "at your stop" and "running late", in the app and as phone notifications.',
      'Arrival times use live traffic.',
    ],
  },
  {
    slug: 'kenyan-curriculum',
    label: 'Kenyan curriculum',
    title: 'CBE and 8-4-4 assessment',
    image: '/images/curriculum.webp',
    alt: 'BloomEd subjects screen for a Kenyan school, with an Add from KICD button for curriculum subjects',
    description: 'CBE and 8-4-4, in one system. ',
    points: [
      'CBE from PP1 to Grade 12, including senior-school pathways, KICD learning areas, strands and sub-strands, and 4- or 8-level rubrics (EE, ME, AE, BE).',
      '8-4-4 for Forms 1 to 4, graded on the KCSE 12-point scale.',
      'Results cannot be published until every learner has been assessed.',
    ],
  },
  {
    slug: 'fees',
    label: 'Fees Payment',
    title: 'School fees management',
    image: '/images/Fees.webp',
    alt: 'BloomEd fees dashboard showing fees collected this term and how many learners have paid in full, part paid or not paid',
    description: 'Every parent knows what they owe and how to pay.',
    points: [
      'Fee structures set by year group and by boarding or day.',
      'Parents see each child\'s balance, the school\'s paybill, till, bank details and suggested part payments.',
      'Parents upload proof of payment and the bursar confirms or rejects it.',
    ],
  },
  {
    slug: 'communication',
    label: 'Communication',
    title: 'Parent and school communication',
    image: '/images/communication.webp',
    alt: 'BloomEd announcement screen for sending a notice to the whole school, all parents, one year group or one class',
    description: 'Reach the right parents in one tap.',
    points: [
      'Announcements go to the whole school, all parents, one year group or one class.',
      'Messages arrive instantly in the app, with unread counts and phone notifications.',
      'Teachers can message the parents or students of their class.',
    ],
  },
  {
    slug: 'less-admin-work',
    label: 'Less admin work',
    title: 'School administration and reports',
    image: '/images/admin-work.webp',
    alt: 'BloomEd school settings screen with a guided checklist for term dates, classes, subjects and grading, and class teachers',
    description: 'Set up a whole school in an afternoon',
    points: [
      'Import all learners from a spreadsheet, with errors flagged before anything is saved.',
      'Reports on attendance, fee collection, academic performance and CBE levels.',
      'Teachers request leave in the app, and the admin assigns a substitute for each affected lesson.',
    ],
  },

  {
    slug: 'parents',
    label: 'One home screen for parents',
    title: 'One home screen for parents',
    image: '/images/Parent.webp',
    alt: 'BloomEd parent home screen showing a child\'s fee balance, attendance, learning area results and school notices',
    description: 'Everything about your child, in one place.',
    points: [
      'One screen per child, with a switcher for families with several children.',
      'Fee balance, attendance, mean grade, absences and the latest school notices.',
      'The parent app shows the last balance and results, even when offline.',
    ],
  },
];

// Number of tabs shown on phones before "See all" is tapped
const MOBILE_VISIBLE_TABS = 4;

const HASH_PREFIX = '#features-';

function Features () {
     const [activeFeature, setActiveFeature] = useState(0);
     const [showAllTabs, setShowAllTabs] = useState(false);
     const hiddenCount = featureTabs.length - MOBILE_VISIBLE_TABS;

     // Links like "#features-fees" open that tab and scroll to the section.
     useEffect(() => {
       const openFromHash = () => {
         const hash = window.location.hash;
         if (!hash.startsWith(HASH_PREFIX)) return;
         const index = featureTabs.findIndex((feature) => feature.slug === hash.slice(HASH_PREFIX.length));
         if (index === -1) return;
         setActiveFeature(index);
         setShowAllTabs(false);
         document.getElementById('features')?.scrollIntoView();
         // Settle on the plain section anchor so clicking the same link again is a hash change again.
         window.history.replaceState(null, '', '#features');
       };
       openFromHash();
       window.addEventListener('hashchange', openFromHash);
       return () => window.removeEventListener('hashchange', openFromHash);
     }, []);

    return(
        <section className="feature-showcase" id="features">
        <h2 className='pt-3 pb-4 text-center font-bold text-[#FF9400] text-3xl'>School management features</h2>
        <div className="feature-showcase-inner">
          <div
            className={`feature-tabs${showAllTabs ? ' is-expanded' : ''}`}
            role="tablist"
            aria-label="School features"
          >
            {featureTabs.map((feature, index) => {
              // Extra tabs are hidden on phones until expanded, but the active one always stays visible
              const isExtra = index >= MOBILE_VISIBLE_TABS && activeFeature !== index;
              return (
                <button
                  aria-controls={`feature-tab-panel-${index}`}
                  aria-selected={activeFeature === index}
                  className={`feature-tab${activeFeature === index ? ' is-active' : ''}${isExtra ? ' is-extra' : ''}`}
                  id={`feature-tab-${index}`}
                  key={feature.label}
                  onClick={() => {
                    setActiveFeature(index);
                    setShowAllTabs(false);
                  }}
                  role="tab"
                  type="button"
                >
                  {feature.label}
                  {feature.label === 'Communications' && (
                    <span className="feature-tab-note"> (KeyChat)</span>
                  )}
                </button>
              );
            })}
            {hiddenCount > 0 && (
              <button
                aria-expanded={showAllTabs}
                className="feature-tabs-toggle"
                onClick={() => setShowAllTabs((open) => !open)}
                type="button"
              >
                {showAllTabs ? 'Show less' : `See all (${featureTabs.length})`}
              </button>
            )}
          </div>

          {/* Every panel is in the page (inactive ones are `hidden`), so search engines
              can read all of them, not just whichever tab happens to be open. */}
          {featureTabs.map((feature, index) => (
            <div
              aria-labelledby={`feature-tab-${index}`}
              className="feature-panel"
              hidden={activeFeature !== index}
              id={`feature-tab-panel-${index}`}
              key={feature.slug}
              role="tabpanel"
            >
              <div className="feature-panel-copy">
                <h3>{feature.title}</h3>
                <p className="feature-description">{feature.description}</p>
                <ul className="feature-points">
                  {feature.points.map((point) => (
                    <li key={point}>
                      <span aria-hidden="true">✓</span>
                      {point}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="feature-panel-media">
                <div className="feature-panel-image">
                  <img
                    src={feature.image}
                    alt={feature.alt}
                    decoding="async"
                    loading="lazy"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

    )
}

export default Features;
