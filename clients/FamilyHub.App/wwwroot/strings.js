let language = "en";
let catalog = Object.create(null);
let request = 0;

export const locale = () => language === "hu" ? "hu-HU" : undefined;

export function text(key, ...args) {
    const value = Object.prototype.hasOwnProperty.call(catalog, key) ? catalog[key] : key;
    return args.length ? value.replace(/\{(\d+)\}/g, (placeholder, index) => {
        if (index >= args.length) return placeholder;
        const argument = args[index];
        return typeof argument === "number" && locale() ? argument.toLocaleString(locale(), { useGrouping: false }) : String(argument ?? "");
    }) : value;
}

export function fixed(number, digits) {
    return locale() ? number.toLocaleString(locale(), {
        minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false
    }) : number.toFixed(digits);
}

export function serverError(reply, fallback) {
    const key = typeof reply?.code === "string" ? "Error." + reply.code : "";
    if (key && Object.prototype.hasOwnProperty.call(catalog, key)) return catalog[key];
    return typeof reply?.error === "string" && reply.error ? text(reply.error) : fallback;
}

export async function setLanguage(value) {
    const next = value === "hu" ? "hu" : "en";
    const current = ++request;
    let strings = Object.create(null);
    if (next === "hu") {
        try {
            const response = await fetch(new URL("./strings.hu.json", import.meta.url));
            if (!response.ok) throw new Error("catalog unavailable");
            strings = await response.json();
        } catch {
            console.warn("FamilyHub could not load the Hungarian interface catalog.");
        }
    }
    if (current !== request) return;
    catalog = strings;
    language = next;
    document.documentElement.lang = next;
    for (const node of document.querySelectorAll("[data-string]")) {
        const value = text(node.dataset.string);
        if (node.dataset.stringAttribute) node.setAttribute(node.dataset.stringAttribute, value);
        else node.textContent = value;
    }
}

