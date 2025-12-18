import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

import Overlay from "./Overlay";

const path = window.location.pathname;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {path === "/overlay" ? <Overlay /> : <App />}
  </React.StrictMode>,
);
