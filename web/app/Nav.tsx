"use client";

import { useEffect, useState } from "react";

export default function Nav() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.setAttribute(
      "data-theme",
      next ? "dark" : "light",
    );
    try {
      localStorage.setItem("telt-theme", next ? "dark" : "light");
    } catch {
      // A browser that refuses storage still gets the theme for this visit.
    }
  }

  return (
    <nav className="nav">
      <div className="nav-left">
        <a className="wordmark" href="/">
          telt<span className="wm-accent">.</span>
        </a>
      </div>
      <div className="nav-links">
        <a href="/#workflow">How it works</a>
        <a href="/#demo">Demo</a>
        <a href="/verify">Verify</a>
        <a href="https://github.com/Iziedking/kertel">Source</a>
      </div>
      <div className="nav-right">
        <button
          className="theme-toggle"
          onClick={toggle}
          aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
        >
          {dark ? "☀" : "◐"}
        </button>
      </div>
    </nav>
  );
}
