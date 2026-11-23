import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { applyA11y, loadA11y } from "./lib/a11y";

// Before the first render, so a saved text size never flashes at 100% first.
applyA11y(loadA11y());

const root = createRoot(document.getElementById("root")!);

// The public marketing page is what search engines and first-time visitors load, and it needs
// nothing from the app (router, Supabase, maps, ~60 screens). So "/" boots on the landing chunk
// alone and every other path loads the full app. The landing page links into the app with plain
// <a href>s, so moving between the two is an ordinary page load that takes the other branch.
if (window.location.pathname === "/") {
  void import("./screens/landing/Landing").then(({ default: Landing }) => {
    root.render(
      <React.StrictMode>
        <Landing />
      </React.StrictMode>
    );
  });
} else {
  // A build talks to Supabase (the whole app) or to the new API (only what has been moved over: src/api/). VITE_BACKEND picks.
  const loadApp = import.meta.env.VITE_BACKEND?.trim().toLowerCase() === "api"
    ? import("./api/ApiApp").then((m) => m.ApiApp)
    : import("./App").then((m) => m.App);
  void Promise.all([import("react-router-dom"), loadApp, import("./lib/client")]).then(
    ([{ BrowserRouter }, App]) => {
      root.render(
        <React.StrictMode>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </React.StrictMode>
      );
    }
  );
}
