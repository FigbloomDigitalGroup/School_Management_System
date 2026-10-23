import Audiences from './Audiences';
import Benefits from './Benefits';
import Contact from './Contact';
import Features from './Features';
import Footer from './Footer';
import Home from './Home';

/** Public marketing page, served at "/". Its CSS is global-by-nature, so everything is scoped under .landing-root. */
export default function Landing() {
  return (
    <div id="top" className="landing-root">
      <Home />
      <Features />
      <Audiences />
      <Benefits />
      <Contact />
      <Footer />
    </div>
  );
}
