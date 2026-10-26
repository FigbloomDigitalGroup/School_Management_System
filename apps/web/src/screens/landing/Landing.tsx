import Audiences from './Audiences';
import Benefits from './Benefits';
import Contact from './Contact';
import Faq from './Faq';
import Features from './Features';
import Footer from './Footer';
import Home, { SiteHeader } from './Home';
import Overview from './Overview';

/** Public marketing page, served at "/". Its CSS is global-by-nature, so everything is scoped under .landing-root. */
export default function Landing() {
  return (
    <div id="top" className="landing-root">
      <SiteHeader />
      <main>
        <Home />
        <Overview />
        <Features />
        <Audiences />
        <Benefits />
        <Faq />
        <Contact />
      </main>
      <Footer />
    </div>
  );
}
