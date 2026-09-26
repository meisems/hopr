import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

// Disable transitions on initial load to prevent flash
document.documentElement.classList.add('no-transitions');

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

// Re-enable transitions after initial render
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    document.documentElement.classList.remove('no-transitions');
  });
});
