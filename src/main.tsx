import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { FlintErrorBoundary } from "./components/error-boundary";
import "./index.css";

// FIX 5: disable the browser/webview right-click context menu for the main
// window. Flint is a native-feeling app, not a web page — the default
// Chromium menu (Back/Refresh/Save as/Print/Inspect) is out of place and
// exposes internals we don't want surfaced. DevTools stays accessible in
// dev builds via F12 / Ctrl+Shift+I because Tauri enables it by default
// only in debug builds.
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <FlintErrorBoundary label="main">
      <App />
    </FlintErrorBoundary>
  </React.StrictMode>,
);
