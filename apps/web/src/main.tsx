import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./lib/client";
import "./index.css";
import { applyA11y, loadA11y } from "./lib/a11y";

// Before the first render, so a saved text size never flashes at 100% first.
applyA11y(loadA11y());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
