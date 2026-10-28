(() => {
  const config = window.RTM_RECRUITING || { email: "", phone: "" };
  const year = document.querySelector("#year");
  if (year) year.textContent = new Date().getFullYear();

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
