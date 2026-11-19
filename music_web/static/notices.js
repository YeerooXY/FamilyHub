"use strict";
(() => {
  const icons = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
    success: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    warning: '<path d="m21.7 18-8-14a2 2 0 0 0-3.5 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3"/><path d="M12 9v4m0 4h.01"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
    empty: '<path d="M9 18V5l12-2v13M9 9l12-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="18" cy="16" rx="3" ry="3"/>'
  };
  const mounted = new WeakMap();
  let stack, bars = [], lostAction;
  const toasts = new Map();

  function set(target, message, { level = "info", action, fallback, quiet = false } = {}) {
    const root = typeof target === "string" ? document.getElementById(target) : target;
    if (!root) return;
    let parts = mounted.get(root);
    if (!parts) {
      const copy = document.createElement("span"), icon = document.createElement("span");
      const text = document.createElement("span"), button = document.createElement("button");
      copy.className = "fh-notice-copy"; icon.className = "fh-notice-icon";
      icon.setAttribute("aria-hidden", "true");
      text.className = "fh-notice-text"; button.className = "fh-notice-action"; button.type = "button";
      copy.append(icon, text);
      root.classList.add("fh-notice");
      root.removeAttribute("role");
      root.replaceChildren(copy, button);
      parts = { icon, text, button };
      mounted.set(root, parts);
    }
    const { icon, text, button } = parts;
    if (parts.level !== level) {
      parts.level = level;
      root.dataset.level = level;
      icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + icons[level] + '</svg>';
      text.setAttribute("role", level === "error" ? "alert" : "status");
      if (level === "error") text.removeAttribute("aria-live");
      else text.setAttribute("aria-live", "polite");
      text.setAttribute("aria-atomic", "true");
    }
    if (fallback) root.dataset.noticeFocus = fallback;
    else if (action && !root.dataset.noticeFocus) root.dataset.noticeFocus = "#content";
    root.hidden = !message;
    root.classList.toggle("sr", quiet);
    if (text.textContent !== (message || "")) text.textContent = message || "";
    button.hidden = !action;
    if (action) {
      if (button.textContent !== action.label) button.textContent = action.label;
      button.onclick = action.run;
    }
  }

  function focusFallback(selector) {
    const targets = [selector && document.querySelector(selector), document.querySelector(":is(dialog[open], [popover]:popover-open) button"), document.getElementById("content")];
    for (const target of targets) {
      if (!target || !target.getClientRects().length) continue;
      target.focus({ preventScroll: true });
      if (document.activeElement === target) break;
    }
  }

  document.addEventListener("focusin", ({ target }) => {
    const root = target.closest("[data-notice-focus]");
    lostAction = root ? { target, selector: root.dataset.noticeFocus } : undefined;
  });
  new MutationObserver(() => {
    if (!lostAction || lostAction.target.getClientRects().length) return;
    const { target, selector } = lostAction;
    lostAction = undefined;
    if (document.activeElement === document.body || document.activeElement === target) focusFallback(selector);
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "open"] });

  function positionToasts() {
    if (!stack?.childElementCount) return;
    const viewport = window.visualViewport;
    const bottom = (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight);
    const top = Math.min(bottom, ...bars.flatMap(bar => {
      const box = bar.getBoundingClientRect();
      const side = bar.matches("#music-navigation, .sidebar");
      return box.height && box.bottom > 0 && box.top < bottom
        && (!side || box.top > bottom * .55) ? [box.top] : [];
    }));
    stack.style.setProperty("--notice-bottom", Math.max(16, innerHeight - top + 12) + "px");
    stack.style.setProperty("--notice-toast-space", Math.max(0, top - (viewport?.offsetTop ?? 0) - 24) + "px");
  }
  const barObserver = new ResizeObserver(positionToasts);
  window.addEventListener("resize", positionToasts);
  window.visualViewport?.addEventListener("resize", positionToasts);
  window.visualViewport?.addEventListener("scroll", positionToasts);

  function toast(message) {
    if (!message) return;
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "fh-toast-stack";
      document.body.append(stack);
    }
    if (toasts.size === 3) {
      const replaceable = [...toasts.values()].find(item => !item.paused());
      if (!replaceable) return;
      replaceable.remove();
    }
    const root = document.createElement("div");
    root.tabIndex = 0;
    stack.append(root);
    set(root, message, { level: "success" });
    barObserver.disconnect();
    bars = [...document.querySelectorAll(".player-bar, .remote-mini, #device-strip, #handoff-message, #music-navigation, body > .sidebar")];
    bars.forEach(bar => barObserver.observe(bar));
    positionToasts();

    let remaining = 5000, started, timer, hovered = false, focused = false;
    const paused = () => hovered || focused;
    const remove = () => { clearTimeout(timer); toasts.delete(root); root.remove(); };
    function update() {
      if (paused() && timer !== undefined) {
        clearTimeout(timer); timer = undefined;
        remaining = Math.max(0, remaining - (performance.now() - started));
      } else if (!paused() && timer === undefined) {
        started = performance.now(); timer = setTimeout(remove, remaining);
      }
    }
    root.addEventListener("pointerenter", event => { if (event.pointerType !== "touch") { hovered = true; update(); } });
    root.addEventListener("pointerleave", () => { hovered = false; update(); });
    root.addEventListener("focus", () => { focused = true; update(); });
    root.addEventListener("blur", () => { focused = false; update(); });
    toasts.set(root, { paused, remove });
    update();
  }
  window.FamilyHubNotices = { set, toast };
})();
