import './Faq.css';

// The same list drives the visible FAQ and the FAQPage structured data, so the two cannot drift apart.
// Answers are plain text on purpose (structured data answers must match what visitors can read).
const faqs = [
  {
    question: 'What is a school management system?',
    answer:
      'A school management system is software that helps a school run its daily work in one place: learner records, fees, attendance, exam results, staff and communication with parents. BloomEd covers all of these, so teachers, administrators and parents work from the same up-to-date information instead of paper registers and spreadsheets.',
  },
  {
    question: 'Does BloomEd support the CBE and 8-4-4 curricula?',
    answer:
      'Yes. For CBE it covers PP1 to Grade 12, including senior-school pathways, KICD learning areas, strands and sub-strands, and 4- or 8-level rubrics. For 8-4-4 it supports Forms 1 to 4, graded on the KCSE 12-point scale. Results cannot be published until every learner has been assessed.',
  },
  {
    question: 'How does BloomEd handle school fees?',
    answer:
      "The school sets fee structures by year group and by boarding or day. In the parent app, each parent sees their child's balance, the school's paybill, till and bank details, and suggested part payments. Parents upload proof of payment and the bursar confirms or rejects it. Administrators can see fee collection by class in the reports.",
  },
  {
    question: 'Can parents track the school bus?',
    answer:
      'Yes. Parents see their child\'s bus on a live map with the child\'s stop marked, and get updates such as "on its way", "1 km away", "at your stop" and "running late", in the app and as phone notifications. Drivers share the bus location from their phone during a trip.',
  },
  {
    question: 'Does BloomEd work when the internet is slow or unreliable?',
    answer:
      'It is built for weak networks. Teachers can record attendance even when the signal drops, and the parent app shows the last fee balance and results even when offline. The apps are light enough to run on low-cost Android phones.',
  },
  {
    question: 'Who can use BloomEd?',
    answer:
      "BloomEd gives school administrators, teachers, parents, students and drivers their own access, so each person sees only what they need. School groups can oversee every school from one account, and colleges can manage courses, students and fees. Each school's data stays separate from every other school's.",
  },
  {
    question: 'How do I get a demo of BloomEd?',
    answer:
      'Use the form on this page to request a free demo, or contact us by email, phone or WhatsApp. We give you a 30-minute walkthrough tailored to your school, answer your questions on fees, CBE assessment and bus tracking, and help you move your learner records across.',
  },
];

const structuredData = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: faqs.map((faq) => ({
    '@type': 'Question',
    name: faq.question,
    acceptedAnswer: { '@type': 'Answer', text: faq.answer },
  })),
};

function Faq() {
  return (
    <section className="faq" id="faq">
      <div className="faq-inner">
        <div className="faq-header">
          <h2 className='pt-3 pb-4 text-center font-bold text-[#FF9400] text-3xl'>Frequently asked questions</h2>
          <p>
            Short answers about how BloomEd works for Kenyan schools. Can't find yours?{' '}
            <a href="#contact">Contact us</a> and we'll help.
          </p>
        </div>

        <div className="faq-list">
          {faqs.map((faq) => (
            <details className="faq-item" key={faq.question}>
              <summary>
                <h3>{faq.question}</h3>
              </summary>
              <p className="faq-answer">{faq.answer}</p>
            </details>
          ))}
        </div>
      </div>

      <script
        type="application/ld+json"
        // "<" is escaped so the JSON can never close the script tag early.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }}
      />
    </section>
  );
}

export default Faq;
