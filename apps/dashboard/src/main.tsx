import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import "./index.css";
import { ThemeProvider } from "@/components/theme-provider.tsx";

import App from "./app.tsx";

const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("TokTracker dashboard root element was not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="toktracker-theme">
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>
);
