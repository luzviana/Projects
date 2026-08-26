(() => {
  "use strict";

  const avatarSelector =
    ".pf-v5-c-masthead img.pf-v5-c-avatar, .pf-v5-c-masthead svg.pf-v5-c-avatar";
  const overviewId = "ngenious-account-overview";
  const hiddenApplications = new Set([
    "account",
    "account-console",
    "admin-cli",
    "broker",
    "realm-management",
    "security-admin-console",
  ]);
  const prefixPattern = /^(?:user\s+)?avatar(?:\s+(?:for|of))?\s*/i;
  let overviewLoading = false;

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

  function accountApiUrl(resource) {
    const accountIndex = window.location.pathname.indexOf("/account/");
    const accountPath =
      accountIndex === -1
        ? `${window.location.pathname.replace(/\/$/, "")}/`
        : window.location.pathname.slice(0, accountIndex + "/account/".length);
    return new URL(resource, `${window.location.origin}${accountPath}`).toString();
  }

  async function accountData(resource) {
    const response = await fetch(accountApiUrl(resource), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`Account request failed with HTTP ${response.status}`);
    }

    return response.json();
  }

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (text) {
      node.textContent = text;
    }
    return node;
  }

  function applicationUrl(application) {
    if (!application.effectiveUrl || hiddenApplications.has(application.clientId)) {
      return "";
    }

    try {
      const url = new URL(application.effectiveUrl, window.location.origin);
      return url.protocol === "https:" ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function organizationCard(organizations) {
    const card = element("article", "ngenious-overview-card");
    card.append(
      element("p", "ngenious-overview-card__label", "Organization"),
      element(
        "h3",
        "ngenious-overview-card__title",
        organizations.length === 1 ? organizations[0].name : "Your organizations",
      ),
    );

    if (organizations.length === 0) {
      card.append(
        element(
          "p",
          "ngenious-overview-card__empty",
          "No organization has been assigned yet.",
        ),
      );
      return card;
    }

    if (organizations.length > 1) {
      const list = element("ul", "ngenious-organization-list");
      organizations.forEach((organization) => {
        list.append(element("li", "", organization.name));
      });
      card.append(list);
    } else {
      card.append(
        element(
          "p",
          "ngenious-overview-card__detail",
          organizations[0].description || "Your ngenious service organization",
        ),
      );
    }

    return card;
  }

  function applicationsCard(applications) {
    const card = element("article", "ngenious-overview-card");
    card.append(
      element("p", "ngenious-overview-card__label", "Applications"),
      element("h3", "ngenious-overview-card__title", "Your services"),
    );

    const launchable = applications
      .map((application) => ({ application, url: applicationUrl(application) }))
      .filter(({ url }) => url)
      .sort(({ application: left }, { application: right }) =>
        (left.clientName || left.clientId).localeCompare(right.clientName || right.clientId),
      );

    if (launchable.length === 0) {
      card.append(
        element(
          "p",
          "ngenious-overview-card__empty",
          "No applications have been assigned yet.",
        ),
      );
      return card;
    }

    const list = element("ul", "ngenious-application-list");
    launchable.forEach(({ application, url }) => {
      const item = element("li", "ngenious-application");
      const copy = element("div", "ngenious-application__copy");
      copy.append(
        element(
          "strong",
          "ngenious-application__name",
          application.clientName || application.clientId,
        ),
      );
      if (application.description) {
        copy.append(element("span", "ngenious-application__description", application.description));
      }

      const link = element("a", "ngenious-application__link", "Open");
      link.href = url;
      link.setAttribute("aria-label", `Open ${application.clientName || application.clientId}`);
      item.append(copy, link);
      list.append(item);
    });
    card.append(list);
    return card;
  }

  async function applyAccountOverview() {
    const firstName = document.querySelector('input[name="firstName"]');
    const existing = document.getElementById(overviewId);

    if (!firstName) {
      existing?.remove();
      return;
    }
    if (existing || overviewLoading) {
      return;
    }

    const main = firstName.closest("main") || document.querySelector("main");
    const generalHeading = Array.from(main?.querySelectorAll("h2") || []).find(
      (heading) => heading.textContent.trim().toLocaleLowerCase() === "general",
    );
    if (!main || !generalHeading) {
      return;
    }

    overviewLoading = true;
    const overview = element("section", "ngenious-account-overview");
    overview.id = overviewId;
    overview.setAttribute("aria-labelledby", `${overviewId}-title`);
    const title = element("h2", "ngenious-account-overview__title", "Your ngenious access");
    title.id = `${overviewId}-title`;
    const grid = element("div", "ngenious-account-overview__grid");
    grid.setAttribute("aria-live", "polite");
    grid.append(element("p", "ngenious-account-overview__loading", "Loading your access…"));
    overview.append(title, grid);
    generalHeading.insertAdjacentElement("beforebegin", overview);

    try {
      const [organizations, applications] = await Promise.all([
        accountData("organizations/"),
        accountData("applications"),
      ]);
      grid.replaceChildren(
        organizationCard(Array.isArray(organizations) ? organizations : []),
        applicationsCard(Array.isArray(applications) ? applications : []),
      );
    } catch {
      grid.replaceChildren(
        element(
          "p",
          "ngenious-account-overview__error",
          "Your access information is temporarily unavailable. Please refresh the page.",
        ),
      );
    } finally {
      overviewLoading = false;
    }
  }

  applyInitials();
  applyAccountOverview();
  new MutationObserver(() => {
    applyInitials();
    applyAccountOverview();
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });
})();
