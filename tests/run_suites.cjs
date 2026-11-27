// Runs browser suites one after another and exits non-zero if any fails.
// Usage: node tests/run_suites.cjs movies_home_layout movies_download_flow
const {spawnSync} = require("node:child_process");
const path = require("node:path");

const names = process.argv.slice(2);
if (!names.length) {
    console.error("Name at least one suite, for example: node tests/run_suites.cjs movies_web");
    process.exit(2);
}
const failed = [];
for (const name of names) {
    const file = path.join(__dirname, name.replace(/\.cjs$/, "") + ".cjs");
    const result = spawnSync(process.execPath, [file], {stdio: "inherit"});
    console.log(`${name}: exit ${result.status ?? result.signal}`);
    if (result.status !== 0) failed.push(name);
}
if (failed.length) {
    console.error("Failed: " + failed.join(", "));
    process.exit(1);
}
