import React from "react";
import ReactDOM from "react-dom/client";
import { OverlayApp } from "./overlay-app";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <OverlayApp />
  </React.StrictMode>,
);
