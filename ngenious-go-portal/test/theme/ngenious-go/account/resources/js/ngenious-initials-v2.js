(() => {
  "use strict";

  const avatarSelector =
    ".pf-v5-c-masthead img.pf-v5-c-avatar, .pf-v5-c-masthead svg.pf-v5-c-avatar";
  const prefixPattern = /^(?:user\s+)?avatar(?:\s+(?:for|of))?\s*/i;

  function initialsFromName(name) {
    const parts = name
      .replace(prefixPattern, "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (parts.length === 0) {
      return "";
    }

    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return `${first}${last}`.toLocaleUpperCase().slice(0, 2);
  }

  function profileName() {
    const firstName = document.querySelector('input[name="firstName"]')?.value?.trim();
    const lastName = document.querySelector('input[name="lastName"]')?.value?.trim();
    return [firstName, lastName].filter(Boolean).join(" ");
  }

  function applyInitials() {
    document.querySelectorAll(avatarSelector).forEach((avatar) => {
      if (avatar.dataset.ngeniousInitials === "true") {
        return;
      }

      const button = avatar.closest("button");
      const name =
        avatar.getAttribute("alt")?.trim() ||
        button?.getAttribute("aria-label")?.trim() ||
        button?.getAttribute("title")?.trim() ||
        profileName();
      const initials = initialsFromName(name || "");

      if (!initials) {
        return;
      }

      const badge = document.createElement("span");
      badge.className = "ngenious-user-initials";
      badge.textContent = initials;
      badge.setAttribute("role", "img");
      badge.setAttribute("aria-label", `${name} initials`);

      avatar.dataset.ngeniousInitials = "true";
      avatar.classList.add("ngenious-user-avatar-image");
      avatar.setAttribute("aria-hidden", "true");
      avatar.insertAdjacentElement("afterend", badge);
    });
  }

  applyInitials();
  new MutationObserver(applyInitials).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
