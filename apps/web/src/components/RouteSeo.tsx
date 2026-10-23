import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const APP_NAME = "Figbloom School Systems";

/** Page names for the signed-in app. A path that matches none of these is the not-found page. */
const PAGE_TITLES: Array<[RegExp, string]> = [
  [/^\/signin$/, "Sign in"],
  [/^\/signup$/, "Sign up"],
  [/^\/reset-password$/, "Reset your password"],
  [/^\/org-picker$/, "Choose your organisation"],
  [/^\/platform(\/|$)/, "Platform console"],
  [/^\/s\/[^/]+(\/|$)/, "School console"],
  [/^\/org\/[^/]+(\/|$)/, "Organisation console"],
];

interface HeadSnapshot {
  title: string;
  robots: string | null;
  canonical: string | null;
}

// What index.html shipped for the marketing page, so "/" can be restored after client-side navigation.
let landing: HeadSnapshot | undefined;

function setRobots(content: string | null) {
  let tag = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
  if (content === null) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement("meta");
    tag.name = "robots";
    document.head.appendChild(tag);
  }
  tag.content = content;
}

function setCanonical(href: string | null) {
  let tag = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (href === null) {
    tag?.remove();
    return;
  }
  if (!tag) {
    tag = document.createElement("link");
    tag.rel = "canonical";
    document.head.appendChild(tag);
  }
  tag.href = href;
}

/**
 * Everything behind "/" is a private, signed-in app: it should never be indexed and shouldn't
 * inherit the marketing page's title or canonical. This keeps <head> honest as the route changes;
 * vercel.json sends the matching X-Robots-Tag header for crawlers that don't run JavaScript.
 */
export function RouteSeo() {
  const { pathname } = useLocation();

  useEffect(() => {
    if (!landing) {
      landing = {
        title: document.title,
        robots: document.head.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content ?? null,
        canonical: document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
      };
    }

    if (pathname === "/") {
      document.title = landing.title;
      setRobots(landing.robots);
      setCanonical(landing.canonical);
      return;
    }

    const page = PAGE_TITLES.find(([pattern]) => pattern.test(pathname))?.[1] ?? "Page not found";
    document.title = `${page} | ${APP_NAME}`;
    setRobots("noindex, nofollow");
    setCanonical(null);
  }, [pathname]);

  return null;
}
