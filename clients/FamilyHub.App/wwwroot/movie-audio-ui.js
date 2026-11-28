import { locale, serverError, text as t } from "./strings.js";

const languageNames = Intl.DisplayNames ? new Intl.DisplayNames(["en"], { type: "language" }) : null;
const hungarianLanguageNames = Intl.DisplayNames ? new Intl.DisplayNames(["hu-HU"], { type: "language" }) : null;
const codes = { hun: "hu", eng: "en", deu: "de", ger: "de", fra: "fr", fre: "fr", jpn: "ja",
    spa: "es", ita: "it", pol: "pl", ces: "cs", slk: "sk", por: "pt", ron: "ro", ukr: "uk", rus: "ru", zho: "zh" };

export function audioLanguage(code) {
    const value = code?.toLowerCase().split(/[-_]/)[0];
    const names = locale() ? hungarianLanguageNames : languageNames;
    return /^[a-z]{2,3}$/.test(value) && value !== "und" ? (names?.of(codes[value] ?? value) ?? ({hu: t("Hungarian"), en: t("English")}[codes[value] ?? value] || value)) : t("Language unknown");
}

function make(tag, text) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
}

function button(text, click) {
    const action = make("button", text);
    action.type = "button";
    action.onclick = click;
    return action;
}

export function movieDialog(parent, opener, title, signal, {content, initialFocus, className} = {}) {
    const dialog = make("dialog"), heading = make("h2", title), head = make("header");
    dialog.className = className ?? "movie-audio-dialog";
    dialog.setAttribute("aria-label", title);
    const close = button(t("Close"), () => dialog.close());
    head.append(heading, close);
    dialog.append(content ?? head);
    parent.append(dialog);
    const cleanup = () => {
        if (dialog.open) dialog.close();
        if (dialog.contains(document.activeElement) || document.activeElement === document.body)
            if (opener.isConnected) opener.focus({preventScroll: true});
        dialog.remove();
        signal.removeEventListener("abort", cleanup);
    };
    dialog.addEventListener("close", cleanup, {once: true});
    signal.addEventListener("abort", cleanup, {once: true});
    opener.focus({preventScroll: true});
    dialog.showModal();
    (initialFocus ?? close).focus({preventScroll: true});
    return dialog;
}

export function audioJobResults(job, call) {
    const report = make("div");
    report.className = "movie-audio-results";
    if (job.error) report.append(make("p", job.error));
    for (const result of job.results ?? []) {
        const row = make("section");
        if (job.results.length > 1) row.append(make("h4", result.title));
        if (job.results.length > 1 || audioJobRunning(job)) row.append(make("p", result.state));
        if (result.error) row.append(make("p", result.error));
        if (result.report) {
            const { offset_ms: offset, speed_ratio: speed, confidence, deviation_ms: drift,
                cut_warning: cuts, less_certain: dub, matched } = result.report;
            const timing = offset ? `Audio moved ${Math.abs(offset) / 1000} s ${offset < 0 ? "earlier" : "later"}.` : t("Audio timing unchanged.");
            row.append(make("p", t("{0} Confidence {1}.", matched ? timing : "Could not match the audio automatically.", confidence)));
            if (Math.abs(speed - 1) >= 0.005) row.append(make("p", speed > 1 ? t("The audio was sped up slightly to match the video.") : t("The audio was slowed down slightly to match the video.")));
            if (dub) row.append(make("p", t("The source has no English track. The match used changes in volume.")));
            if (cuts) row.append(make("p", t("The cuts may differ. The largest timing difference was {0} s.", drift / 1000)));
        }
        if (result.refresh_pending) row.append(make("p", t("The track was saved. Refresh this title in Jellyfin to make it available.")));
        if (result.can_delete && !audioJobRunning(job)) {
            const status = make("p");
            status.setAttribute("role", "status");
            const remove = button(t("Delete source file"), () => {
                confirm.hidden = false;
                keep.focus();
                remove.hidden = true;
            });
            remove.dataset.audioRemove = result.id;
            const confirm = make("div");
            confirm.className = "movie-audio-confirm";
            const keep = button(t("Keep file"), () => {
                remove.hidden = false;
                remove.focus();
                confirm.hidden = true;
            });
            const yes = button(t("Delete file"), async () => {
                if (yes.getAttribute("aria-disabled") === "true") return;
                yes.focus();
                yes.setAttribute("aria-disabled", "true");
                const reply = await call("MovieDeleteAudioSource", job.id, result.id);
                if (!row.isConnected) return;
                status.textContent = serverError(reply, t("Source file deleted."));
                if (reply?.error) yes.removeAttribute("aria-disabled");
                else {
                    status.tabIndex = -1;
                    status.focus();
                    confirm.remove();
                    remove.remove();
                }
            });
            confirm.append(make("p", t("Delete the original source file from the server?")), keep, yes);
            confirm.hidden = true;
            row.append(remove, confirm, status);
        }
        report.append(row);
    }
    return report;
}

export const audioJobRunning = job => ["Waiting", "Matching audio", "Writing audio"].includes(job.state);

export function addAudioDialog({parent, opener, item, signal, call, onJob, language: initialLanguage = "hu"}) {
    const dialog = movieDialog(parent, opener, t("Add audio track"), signal);
    const title = make("p", item.Name), notice = make("p"), list = make("div"), result = make("div");
    const jobStatus = make("p");
    jobStatus.setAttribute("role", "status");
    const form = make("form"), sourceLabel = make("label", t("Source and audio stream")), source = make("select");
    const chosenSource = make("small");
    chosenSource.className = "movie-audio-source-name";
    const updateSource = () => { chosenSource.textContent = source.selectedOptions[0]?.parentElement.label ?? ""; };
    source.onchange = updateSource;
    sourceLabel.append(source, chosenSource);
    const languageLabel = make("label", t("Track language")), language = make("select");
    const languages = ["hu", "en", "de", "fr", "it", "es", "pt", "ja", "pl", "cs", "sk", "ro", "uk", "ru", "zh"];
    for (const code of languages) language.add(new Option(audioLanguage(code), code));
    language.add(new Option(t("Other language"), "other"));
    language.value = initialLanguage;
    languageLabel.append(language);
    const otherLabel = make("label", t("Three-letter language code")), other = make("input");
    other.pattern = "[A-Za-z]{3}";
    other.maxLength = 3;
    otherLabel.append(other);
    otherLabel.hidden = true;
    language.onchange = () => { otherLabel.hidden = language.value !== "other"; other.required = !otherLabel.hidden; };
    const start = make("button", t("Start matching"));
    const more = button(t("Show more sources"), () => load());
    form.append(sourceLabel, languageLabel, otherLabel, start);
    list.append(form, more);
    notice.setAttribute("role", "status");
    dialog.append(title, notice, list, jobStatus, result);
    const request = async (...args) => {
        try { return await call(...args); }
        catch { return {error: t("The server did not respond. Try again.")}; }
    };
    let offset = null, timer, loading = false, previous;
    const shown = new Set();
    function show(job) {
        const signature = JSON.stringify(job);
        if (signature === previous) return;
        previous = signature;
        jobStatus.textContent = t(job.state);
        result.replaceChildren(audioJobResults(job, request));
    }
    async function poll(jobId) {
        if (!dialog.open) return;
        const reply = await request("MovieDownloads");
        if (!dialog.open) return;
        const job = reply?.items?.find(item => item.id === jobId);
        if (job) {
            show(job);
            if (!audioJobRunning(job)) {
                start.removeAttribute("aria-disabled");
                onJob();
                return;
            }
        }
        if (reply?.error) jobStatus.textContent = serverError(reply);
        timer = setTimeout(() => poll(jobId), 2000);
    }
    async function load() {
        if (loading) return;
        loading = true;
        more.setAttribute("aria-disabled", "true");
        if (!source.options.length) notice.textContent = t("Checking server files…");
        const recommended = offset === null;
        const reply = await request("MovieAudioSources", item.Id, offset);
        if (!dialog.open) return;
        loading = false;
        more.removeAttribute("aria-disabled");
        if (reply?.error || !Array.isArray(reply?.sources)) {
            notice.textContent = serverError(reply, t("Could not check server files."));
            more.textContent = t("Retry source check");
            more.hidden = false;
            return;
        }
        const hadSelection = !!source.value;
        let preferredStream;
        for (const file of reply.sources) {
        if (shown.has(file.id) || file.folder && !["Episode", "Season"].includes(item.Type)) continue;
            shown.add(file.id);
            const group = make("optgroup");
            group.label = `${file.name} (${file.location}${file.folder ? ", season folder" : ""})`;
            for (const stream of file.streams) {
                const details = [audioLanguage(stream.language), stream.codec?.toUpperCase(),
                    stream.channels && t("{0} ch", stream.channels), stream.duration && t("{0} min", Math.round(stream.duration / 60))];
                const option = new Option(details.filter(Boolean).join(", "), `${file.id}:${stream.index}`);
                if (!source.options.length && !preferredStream && details[0] === audioLanguage(language.value))
                    preferredStream = option;
                group.append(option);
            }
            source.append(group);
        }
        if (!hadSelection && source.options.length) source.selectedIndex = preferredStream?.index ?? 0;
        updateSource();
        start.disabled = !source.options.length;
        if (reply.next == null && document.activeElement === more)
            (source.options.length ? source : dialog.querySelector("header button")).focus();
        more.hidden = reply.next == null;
        more.textContent = t("Show more sources");
        offset = reply.next;
        notice.textContent = source.options.length ? "" : offset == null
            ? t("No audio sources found. Place a file in Imports or finish a server download.")
            : recommended ? t("No matching sources found. Show more sources to check other files.")
                : t("No audio sources on this page.");
    }
    form.onsubmit = async event => {
        event.preventDefault();
        if (!source.value || start.getAttribute("aria-disabled") === "true") return;
        start.focus();
        start.setAttribute("aria-disabled", "true");
        const [id, stream] = source.value.split(":");
        const code = language.value === "other" ? other.value.toLowerCase() : language.value;
        jobStatus.textContent = t("Starting audio job…");
        const job = await request("MovieAddAudio", item.Id, id, Number(stream), code, audioLanguage(code));
        if (!dialog.open) return;
        if (job?.error || !job?.id) {
            jobStatus.textContent = serverError(job, t("Could not start matching."));
            start.removeAttribute("aria-disabled");
            return;
        }
        show(job);
        onJob();
        poll(job.id);
    };
    dialog.addEventListener("close", () => clearTimeout(timer), {once: true});
    signal.addEventListener("abort", () => clearTimeout(timer), {once: true});
    start.disabled = true;
    more.hidden = true;
    load();
    request("MovieDownloads").then(reply => {
        if (!dialog.open || previous || start.getAttribute("aria-disabled") === "true") return;
        const job = reply?.items?.find(itemJob => itemJob.item === item.Id);
        if (!job) return;
        show(job);
        if (audioJobRunning(job)) {
            start.setAttribute("aria-disabled", "true");
            poll(job.id);
        }
    });
}
