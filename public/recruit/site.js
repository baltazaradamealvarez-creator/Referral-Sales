(() => {
  const config = window.RTM_RECRUITING || { email: "", phone: "" };
  const year = document.querySelector("#year");
  if (year) year.textContent = new Date().getFullYear();

  // Use IntersectionObserver instead of a scroll listener. Each section enters once,
  // and CSS only animates opacity/transform so the effects stay inexpensive.
  const motionTargets = [
    ".eyebrow", ".hero-lede", ".hero-actions", ".hero-proof", ".hero-visual", ".ticker",
    ".opportunity > .section-kicker", ".opportunity-heading", ".field-image", ".field-copy .section-kicker",
    ".field-copy h2", ".field-copy > p", ".steps", ".photo-grid figure",
    ".strip-heading h2", ".quote-band > *", ".faq-intro > *", ".faq-list details",
    ".connect > *:not(.connect-orb)", "footer > *",
  ];
  motionTargets.forEach((selector) => {
    document.querySelectorAll(selector).forEach((element) => element.setAttribute("data-reveal", ""));
  });

  // Give each visible character its own lightweight transform so headings can
  // fall in one letter at a time. The original accessible label stays intact.
  document.querySelectorAll("[data-letter-drop]").forEach((heading) => {
    const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    let letterIndex = 0;
    textNodes.forEach((textNode) => {
      const fragment = document.createDocumentFragment();
      Array.from(textNode.nodeValue).forEach((character) => {
        if (/\s/.test(character)) {
          fragment.append(document.createTextNode(character));
          return;
        }
        const letter = document.createElement("span");
        letter.className = "letter-drop-char";
        letter.setAttribute("aria-hidden", "true");
        letter.style.setProperty("--letter-index", letterIndex++);
        letter.textContent = character;
        fragment.append(letter);
      });
      textNode.replaceWith(fragment);
    });
  });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!reduceMotion && "IntersectionObserver" in window) {
    document.body.classList.add("motion-ready");
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -36px 0px" });
    document.querySelectorAll("[data-reveal]").forEach((element) => observer.observe(element));
  } else {
    document.querySelectorAll("[data-reveal]").forEach((element) => element.classList.add("is-visible"));
  }

  const menuButton = document.querySelector(".menu-toggle");
  const menu = document.querySelector(".desktop-nav");
  menuButton?.addEventListener("click", () => {
    const open = menu.classList.toggle("open");
    menuButton.setAttribute("aria-expanded", String(open));
    menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  });
  menu?.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
    menu.classList.remove("open");
    menuButton?.setAttribute("aria-expanded", "false");
  }));

  const toast = document.querySelector(".contact-toast");
  let toastTimer;
  document.querySelectorAll("[data-contact-link]").forEach((link) => {
    if (config.email) link.href = `mailto:${encodeURIComponent(config.email)}?subject=${encodeURIComponent("Retail sales opportunity")}`;
    else if (config.phone) link.href = `tel:${config.phone.replace(/[^+\d]/g, "")}`;
    else link.addEventListener("click", (event) => {
      event.preventDefault();
      toast.textContent = "Recruiting contact details are being finalized. Please check back soon.";
      toast.classList.add("show");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toast.classList.remove("show"), 3600);
    });
  });
})();
