/* Pi Scope — docs site behaviour. Vanilla JS, no dependencies.
   Three jobs: scroll reveal, copy-to-clipboard for code blocks, theme toggle. */

(() => {
  // ── Theme: dark is the design default, exactly like the app (which ignores
  //    the OS preference too). Only an explicit light choice wins. ──
  const root = document.documentElement;
  const stored = localStorage.getItem("pi-scope-docs-theme");
  setTheme(stored === "light" ? "light" : "dark");

  function setTheme(theme) {
    root.setAttribute("data-theme", theme);
    const btn = document.querySelector(".theme-toggle");
    if (btn) {
      const dark = theme === "dark";
      btn.textContent = dark ? "☀" : "☾";
      btn.setAttribute(
        "aria-label",
        dark ? "Switch to light theme" : "Switch to dark theme"
      );
      btn.setAttribute("title", dark ? "Light theme" : "Dark theme");
    }
  }

  document.addEventListener("click", (event) => {
    const toggle = event.target.closest(".theme-toggle");
    if (toggle) {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      localStorage.setItem("pi-scope-docs-theme", next);
      setTheme(next);
      return;
    }

    // ── Copy button on every <pre> ──
    const copy = event.target.closest(".copy");
    if (copy) {
      const pre = copy.closest("pre");
      const text = pre ? pre.querySelector("code")?.innerText ?? "" : "";
      navigator.clipboard?.writeText(text).then(
        () => {
          copy.textContent = "copied";
          copy.classList.add("done");
          setTimeout(() => {
            copy.textContent = "copy";
            copy.classList.remove("done");
          }, 1600);
        },
        () => {
          copy.textContent = "ctrl+c";
        }
      );
    }
  });

  // ── Reveal on scroll: one slow, confident settle per element. ──
  const targets = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("in"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    },
    // threshold 0, not a ratio: some revealed blocks (the screenshot tour) are
    // many screens tall, so a ratio threshold would never fire for them.
    { rootMargin: "0px 0px -8% 0px", threshold: 0 }
  );
  targets.forEach((el) => observer.observe(el));

  // ── Add a "copy" affordance to each code block. ──
  document.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".copy")) return;
    const button = document.createElement("button");
    button.className = "copy";
    button.type = "button";
    button.textContent = "copy";
    pre.appendChild(button);
  });
})();
