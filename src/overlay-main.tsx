import React from "react";
import ReactDOM from "react-dom/client";
import { OverlayApp } from "./overlay-app";
import { FlintErrorBoundary } from "./components/error-boundary";
import "./index.css";

// FIX 5: disable the webview's native right-click context menu in the
// overlay window too. The overlay should behave like a desktop widget.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FlintErrorBoundary label="overlay">
      <OverlayApp />
    </FlintErrorBoundary>
  </React.StrictMode>,
);
