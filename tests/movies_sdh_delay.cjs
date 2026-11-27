// Unit checks for the sound-description filter, the audio delay limits and the backup audio preference. No browser, no server.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const wwwroot = path.join(__dirname, "../clients/FamilyHub.App/wwwroot");
const load = name => import(pathToFileURL(path.join(wwwroot, name)).href);

async function verify() {
    const {hideSoundDescriptions: hide} = await load("movie-player-ui.js");
    for (const [input, expected] of [
        ["[door slams]", ""], ["(laughs)", ""], ["[door\nslams]", ""], ["- [door slams]\n- Who is there?", "- Who is there?"],
        ["[music playing] (sighs)", ""], ["♪", ""], ["♪ ♫", ""],
        ["NARRATOR: Once upon a time", "Once upon a time"], ["MAN:\nHello", "Hello"], ["JOHN F. KENNEDY: Ask not", "Ask not"],
        // Kept: lyrics, plain dialogue, brackets or colons inside a sentence.
        ["♪ Happy birthday to you ♪", "♪ Happy birthday to you ♪"],
        ["He said (quietly) that it works.", "He said (quietly) that it works."],
        ["Hello [laughs] there", "Hello [laughs] there"], ["(Not) now.", "(Not) now."],
        ["Meet me at 10:30", "Meet me at 10:30"], ["I told him: no.", "I told him: no."], ["Plain line", "Plain line"]
    ]) assert.equal(hide(input), expected, JSON.stringify(input));

    const {clampAudioDelay, AUDIO_DELAY_LIMIT, AUDIO_DELAY_STEP} = await load("movie-audio-sync.js");
    assert.equal(AUDIO_DELAY_LIMIT, 500);
    assert.equal(AUDIO_DELAY_STEP, 25);
    for (const [input, expected] of [[0, 0], [10, 0], [13, 25], [25, 25], [-37, -25], [-38, -50], [499, 500], [600, 500], [-9999, -500]])
        assert.equal(clampAudioDelay(input), expected, String(input));
    let steps = 0;
    for (let value = -AUDIO_DELAY_LIMIT; value < AUDIO_DELAY_LIMIT; value += AUDIO_DELAY_STEP) steps++;
    assert.equal(steps, 40);

    // The saved value is read back through the same clamp.
    const stored = new Map([["delay", "2000"]]);
    global.localStorage = {getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value)};
    global.document = {createElement: () => ({pause() {}, load() {}, removeAttribute() {}, readyState: 0})};
    const {movieAudioSync} = await load("movie-audio-sync.js");
    const media = {addEventListener() {}};
    const sync = movieAudioSync(media, {key: "delay", signal: new AbortController().signal, stream: "", report() {}, useAudioElement() {}});
    assert.equal(sync.value, 500);
    sync.step(-30);
    assert.equal(sync.value, 475);
    assert.equal(stored.get("delay"), "475");
    sync.step(-2000);
    assert.equal(sync.value, -500);
    sync.step(-25);
    assert.equal(sync.value, -500);
    sync.step(500);
    sync.step(0);
    assert.equal(sync.value, 0);
    delete global.localStorage;
    delete global.document;
    console.log("movie sdh and delay checks passed");
    process.exit(0);
}

verify().catch(error => { console.error(error); process.exit(1); });
