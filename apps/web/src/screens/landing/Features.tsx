import { useState } from 'react';
import './Features.css'

const featureTabs = [
  {
    label: 'Attendance',
    title: 'Attendance',
    description: 'Make attendance easier to record, review, and follow up.',
    points: [
      'Record class attendance and see submissions at a glance.',
      'Identify absences and patterns that may need attention.',
      'Keep teachers and school teams aligned on follow-up.',
    ],
  },
  {
    label: 'Bus Tracking',
    title: 'Bus Tracking',
    image: '/images/Fleet.png',
    description: 'Know exactly where the school bus is.',
    points: [
      'Parents see their child\'s bus on a live map, with the child\'s stop marked.',
      'Parents get updates like "on its way, about 7:42", "1 km away", "at your stop" and "running late", in the app and as phone notifications.',
      'Arrival times use live traffic.',
    ],
  },
  {
    label: ' Kenyan curriculum',
    title: ' Kenyan curriculum',
    image: '/images/curriculum.png',
    description: 'CBE and 8-4-4, in one system. ',
    points: [
      'CBE from PP1 to Grade 12, including senior-school pathways, KICD learning areas, strands and sub-strands, and 4- or 8-level rubrics (EE, ME, AE, BE).',
      '8-4-4 for Forms 1 to 4, graded on the KCSE 12-point scale.',
      'Results cannot be published until every learner has been assessed.',
    ],
  },
  {
    label: 'Fees Payment',
    title: 'Fees Payment',
    image: '/images/Fees.png',
    description: 'Every parent knows what they owe and how to pay.',
    points: [
      'Fee structures set by year group and by boarding or day.',
      'Parents see each child\'s balance, the school\'s paybill, till, bank details and suggested part payments.',
      'Parents upload proof of payment and the bursar confirms or rejects it.',
    ],
  },
  {
    label: 'Communication',
    title: 'Communication',
    image: '/images/communication.png',
    description: 'Reach the right parents in one tap.',
    points: [
      'Announcements go to the whole school, all parents, one year group or one class.',
      'Messages arrive instantly in the app, with unread counts and phone notifications.',
      'Teachers can message the parents or students of their class.',
    ],
  },
  {
    label: 'Less admin work',
    title: 'Less admin work',
    image: '/images/admin-work.png',
    description: 'Set up a whole school in an afternoon',
    points: [
      'Import all learners from a spreadsheet, with errors flagged before anything is saved.',
      'Reports on attendance, fee collection, academic performance and CBE levels.',
      'Teachers request leave in the app, and the admin assigns a substitute for each affected lesson.',
    ],
  },
  
  {
    label: 'One home screen for parents',
    title: 'One home screen for parents',
    image: '/images/Parent.png',
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

function Features () {
     const [activeFeature, setActiveFeature] = useState(1);
     const [showAllTabs, setShowAllTabs] = useState(false);
     const selectedFeature = featureTabs[activeFeature] ?? featureTabs[0]!;
     const hiddenCount = featureTabs.length - MOBILE_VISIBLE_TABS;
    return(
        <section className="feature-showcase" id="features">
        <h1 className='pt-3 pb-4 text-center font-bold text-[#FF9400] text-3xl'>Features</h1>
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
                  aria-controls="feature-tab-panel"
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

          <div
            aria-labelledby={`feature-tab-${activeFeature}`}
            className="feature-panel"
            id="feature-tab-panel"
            role="tabpanel"
          >
            <div className="feature-panel-copy">
              <h2>{selectedFeature.title}</h2>
              <p className="feature-description">{selectedFeature.description}</p>
              <ul className="feature-points">
                {selectedFeature.points.map((point) => (
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
                  src={selectedFeature.image ?? '/images/adminn-dashboard.png'}
                  alt={`${selectedFeature.title} feature`}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

    )
}

export default Features;