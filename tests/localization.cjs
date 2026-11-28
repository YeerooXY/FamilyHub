const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = path.resolve(__dirname, "../clients/FamilyHub.App");
const allowedText = new Set(["FamilyHub", "Spotify", "TMDB", "Trakt", "YouTube", "English", "Magyar"]);

function decodeXml(text) {
    const entities = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'"};
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, name) =>
        name.startsWith("#x") ? String.fromCodePoint(parseInt(name.slice(2), 16))
        : name.startsWith("#") ? String.fromCodePoint(Number(name.slice(1))) : entities[name]);
}

function readStrings(file) {
    const xml = fs.readFileSync(path.join(app, "Resources", file), "utf8");
    const entries = new Map();
    for (const [, rawName, value] of xml.matchAll(/<data name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>\s*<\/data>/g)) {
        const name = decodeXml(rawName);
        assert.ok(!entries.has(name), `${file} repeats ${name}`);
        assert.ok(decodeXml(value).trim(), `${file} leaves ${name} empty`);
        entries.set(name, decodeXml(value));
    }
    assert.ok(entries.size, `${file} has no strings`);
    return entries;
}

function* sourceFiles(folder) {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory() && entry.name !== "vendor") yield* sourceFiles(file);
        else if (entry.isFile() && /\.(?:razor(?:\.cs)?|js|html)$/.test(entry.name) &&
            entry.name !== "paddock-theme.js") yield file;
    }
}

test("visible literals and localization calls have an English resource", () => {
    const catalog = readStrings("Strings.resx");
    const failures = [];
    const files = [...sourceFiles(path.join(app, "Components")), ...sourceFiles(path.join(app, "wwwroot"))];
    for (const file of files) {
        const source = fs.readFileSync(file, "utf8").replace(/@\*[\s\S]*?\*@|^[ \t]*\/\/[^\n]*/gm,
            comment => comment.replace(/[^\n]/g, " "));
        const relative = path.relative(app, file);
        const javascript = file.endsWith(".js");
        const razor = file.endsWith(".razor");
        const html = file.endsWith(".html");
        const patterns = javascript ? [
            /\bt\((?<quote>["'])(?<key>(?:\\.|(?!\k<quote>)[^\\])*)\k<quote>(?=\s*[,)])/g
        ] : razor || file.endsWith(".cs") ? [
            /\bL\["(?<key>(?:\\.|[^"\\])*)"(?=\s*[,\]])/g
        ] : [/data-string="(?<key>[^"]+)"/g];
        for (const pattern of patterns) {
            for (const match of source.matchAll(pattern)) {
                const key = decodeXml(match.groups.key).replace(/\\(['"\\])/g, "$1");
                if (!catalog.has(key)) failures.push(`${relative} uses missing key ${JSON.stringify(key)}`);
            }
        }
        const visibleLiterals = razor || html ? [
            /\b(?:aria-label|aria-description|aria-valuetext|placeholder|alt|title|ActionLabel|RetryLabel|RemoveLabel|Detail|Message)="([A-Za-z][^"<>\r\n@]*)"/g,
            />([A-Za-z][^<>@{}\r\n]*)(?=<\/(?:[a-z][a-z0-9]*|PageTitle)>)/g
        ] : javascript ? [
            /\.(?:textContent|innerText|title|placeholder)\s*=\s*["']([A-Za-z][A-Za-z\s.!?–…-]+)["']/g,
            /\.setAttribute\(["'](?:aria-label|aria-description|aria-valuetext|title|placeholder)["'],\s*["']([A-Za-z][A-Za-z\s.!?–…-]+)["']\)/g,
            /<[a-z][^\r\n>]*\b(?:aria-label|title|placeholder)="([A-Za-z][A-Za-z .!?–…-]+)"/g
        ] : [];
        for (const pattern of visibleLiterals) {
            for (const match of source.matchAll(pattern)) {
                const literal = decodeXml(match[1]).trim();
                if (literal.length < 2 || allowedText.has(literal)) continue;
                const line = source.slice(0, match.index).split("\n").length;
                if (html && source.split("\n")[line - 1].includes(`data-string="${match[1]}"`) && catalog.has(literal)) continue;
                failures.push(`${relative}:${line} renders ${JSON.stringify(literal)} without a resource lookup`);
            }
        }
    }
    assert.deepEqual(failures, []);
});

test("each English resource has a Hungarian value with the same placeholders", () => {
    const english = readStrings("Strings.resx");
    const hungarian = readStrings("Strings.hu.resx");
    assert.deepEqual([...hungarian.keys()].sort(), [...english.keys()].sort());
    const indexes = value => [...new Set([...value.matchAll(/\{(\d+)(?:[^{}]*)\}/g)].map(match => match[1]))].sort();
    for (const [key, value] of english) {
        assert.deepEqual(indexes(hungarian.get(key)), indexes(value), key);
    }
});
