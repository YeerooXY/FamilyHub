const retries = new WeakMap();

export function configureServiceStatus(card, active, automatic, handoff) {
    // A failure that appears while focus is on the control that caused it hands focus to Retry.
    if (active && handoff) {
        const origin = document.querySelector(handoff), action = card.querySelector(".service-status-retry");
        if (origin && action && document.activeElement === origin) action.focus({ preventScroll: true });
    }
    const previous = retries.get(card);
    if (!active || !automatic) {
        if (previous) clearTimeout(previous.timer);
        retries.delete(card);
        const timing = card.querySelector(".service-status-clock");
        if (active && timing && card.querySelector(".service-status-retry")) {
            timing.textContent = card.hasAttribute("data-reconnecting") ? "Trying again…" : "Manual retry";
        }
        return;
    }
    if (previous) return;
    const action = card.querySelector(".service-status-retry");
    if (!action) return;

    const timing = card.querySelector(".service-status-clock");
    const retry = { round: 0, timer: 0 };
    retries.set(card, retry);
    let due = Date.now() + 8000;
    function tick() {
        if (!card.isConnected || card.hidden) {
            retries.delete(card);
            return;
        }
        const remaining = Math.ceil((due - Date.now()) / 1000);
        if (remaining <= 0 && !document.hidden && action.getClientRects().length && action.getAttribute("aria-disabled") !== "true") {
            action.click();
            due = Date.now() + Math.min(30000, 8000 * 2 ** Math.min(++retry.round, 2));
        }
        timing.textContent = action.getAttribute("aria-disabled") === "true" ? "Trying again… "
            : "Trying again in " + Math.max(1, Math.ceil((due - Date.now()) / 1000)) + " s. ";
        retry.timer = setTimeout(tick, 1000);
    }
    tick();
}

export function showServiceRecovery(target) {
    if (typeof target === "string") target = document.querySelector(target);
    if (!target || target.id === "content") return;
    target.classList.add("service-status-restored");
    setTimeout(() => target.classList.remove("service-status-restored"), 180);
}

const serverOutageTitle = "Can't reach your server";

export function createServiceStatus({ title = serverOutageTitle, detail, label, retry, focus, automatic = false, fullSection = false }) {
    const make = (tag, className, copy) => {
        const node = document.createElement(tag);
        node.className = className;
        if (copy) node.textContent = copy;
        return node;
    };
    const card = make("div", "service-status" + (fullSection ? " service-status-section" : ""));
    if (title === serverOutageTitle) card.dataset.serverOutage = "";
    card.dataset.noticeFocus = "#content";
    card.hidden = true;
    const icon = make("span", "service-status-icon");
    icon.setAttribute("aria-hidden", "true");
    const copy = make("div", "service-status-copy");
    const announcement = make("div", "service-status-announcement");
    announcement.setAttribute("role", "status");
    announcement.setAttribute("aria-atomic", "true");
    const description = make("p", "", detail);
    announcement.append(make("strong", "", title), description);
    const timing = make("p", "service-status-timing");
    timing.setAttribute("aria-live", "off");
    const clock = make("span", "service-status-clock");
    timing.append(clock);
    copy.append(announcement, timing);
    const actions = make("div", "service-status-actions");
    const action = make("button", "service-status-retry", label);
    action.type = "button";
    const busy = value => {
        action.setAttribute("aria-disabled", String(value));
        card.toggleAttribute("data-reconnecting", value);
        if (!card.hidden) clock.textContent = value ? "Trying again…" : automatic ? clock.textContent : "Manual retry";
    };
    action.onclick = async () => {
        if (action.getAttribute("aria-disabled") === "true") return;
        busy(true);
        try { await retry(); }
        finally { busy(false); }
    };
    actions.append(action);
    card.append(icon, copy, actions);

    return {
        card,
        show() {
            card.hidden = false;
            configureServiceStatus(card, true, automatic);
        },
        clear() {
            if (card.hidden) return;
            const next = focus?.();
            if (card.contains(document.activeElement)) next?.focus({ preventScroll: true });
            card.hidden = true;
            configureServiceStatus(card, false, automatic);
            showServiceRecovery(next);
        }
    };
}
