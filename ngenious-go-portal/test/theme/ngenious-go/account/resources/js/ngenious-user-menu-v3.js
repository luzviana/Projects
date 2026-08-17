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

  function findUserMenuButton(masthead, avatar) {
    return Array.from(masthead.querySelectorAll("button")).find((button) => {
      const label = button.textContent.trim();
      const isMenuToggle =
        button.hasAttribute("aria-expanded") ||
        button.hasAttribute("aria-haspopup") ||
        button.classList.contains("pf-v5-c-menu-toggle") ||
        button.classList.contains("pf-v5-c-dropdown__toggle");

      return label && isMenuToggle && !button.contains(avatar);
    });
  }

  function applyInitials() {
    document.querySelectorAll(avatarSelector).forEach((avatar) => {
      if (avatar.dataset.ngeniousInitials === "true") {
        return;
      }

      const masthead = avatar.closest(".pf-v5-c-masthead");
      const avatarButton = avatar.closest("button");
      const menuButton = masthead && findUserMenuButton(masthead, avatar);
      const name =
        profileName() ||
        avatar.getAttribute("alt")?.trim() ||
        avatarButton?.getAttribute("aria-label")?.trim() ||
        menuButton?.textContent?.trim() ||
        avatarButton?.getAttribute("title")?.trim();
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

      if (!menuButton) {
        avatar.insertAdjacentElement("afterend", badge);
        return;
      }

      const avatarItem = avatar.closest(".pf-v5-c-toolbar__item");
      const menuItem = menuButton.closest(".pf-v5-c-toolbar__item");

      menuButton.classList.add("ngenious-user-menu-trigger");
      menuButton.setAttribute("aria-label", `Open account menu for ${name}`);
      menuButton.append(badge);
      menuItem?.classList.add("ngenious-user-menu-container");

      if (avatarItem && menuItem && avatarItem !== menuItem) {
        if (avatarItem.parentElement === menuItem.parentElement) {
          avatarItem.parentElement.insertBefore(menuItem, avatarItem);
        }
        avatarItem.classList.add("ngenious-original-avatar");
      }
    });
  }

  applyInitials();
  new MutationObserver(applyInitials).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
