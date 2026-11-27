const assert = require("node:assert/strict");
const {moviePage, reviewMovieProfiles} = require("./movies_fixture.cjs");

const cases = [
    ["KN", "KN"], [6, "6"], ["12", "12"], ["16", "16"], ["18", "18"], ["X", "X"],
    ["G", "KN"], ["PG", "6"], ["PG-13", "12"], ["R", "16"], ["NC-17", "18"],
    ["TV-Y", "KN"], ["TV-Y7", "6"], ["TV-G", "KN"], ["TV-PG", "6"], ["TV-14", "16"], ["TV-MA", "18"],
    ["U", "KN"], ["GB PG", "6"], ["12A", "12"], ["GB-15", "16"], ["R18", "X"], [" hu-12 ", "12"],
    ["NR", null], ["Unrated", null], ["", null], [13, null], [null, null], [false, null]
];

async function check(browser, profile, options) {
    const page = await browser.newPage(options);
    try {
        await moviePage(page);
        await page.evaluate(async inputs => {
            const {ratingBadge} = await import("/movie-releases.js");
            const container = document.querySelector("main");
            inputs.forEach((value, index) => {
                const wrapper = document.createElement("div");
                wrapper.dataset.testid = `rating-${index}`;
                const badge = ratingBadge(value);
                if (badge) wrapper.append(badge);
                container.append(wrapper);
            });
        }, cases.map(([raw]) => raw));
        for (const [index, [raw, label]] of cases.entries()) {
            const wrapper = page.getByTestId(`rating-${index}`);
            const message = `${profile} ${JSON.stringify(raw)}`;
            if (!label) {
                assert.equal(await wrapper.locator("*").count(), 0, message);
                continue;
            }
            const accessible = label === "KN" ? "Suitable for all ages" : label === "X" ? "Adults only" : `Age rating ${label}`;
            const fill = label === "KN" ? "rgb(122, 201, 67)" : ["X", "18"].includes(label) ? "rgb(228, 38, 44)" : "rgb(255, 204, 0)";
            const badge = wrapper.getByRole("img", {name: accessible, exact: true});
            assert.equal(await badge.textContent(), ["KN", "X"].includes(label) ? "" : label, message);
            assert.equal(await badge.getAttribute("data-level"), label, message);
            assert.deepEqual(await badge.evaluate(node => {
                const style = getComputedStyle(node);
                return [style.width, style.height, style.borderTopWidth, style.borderTopColor, style.borderRadius, style.backgroundColor];
            }), ["40px", "40px", "4px", "rgb(0, 0, 0)", "50%", fill], message);
            if (label === "X") {
                const [left, right] = await badge.evaluate(node => ["::before", "::after"].map(part => getComputedStyle(node, part).transform));
                assert.ok(left !== "none" && right !== "none" && left !== right, message);
            }
        }
        const badge = page.getByTestId("rating-0").getByRole("img");
        await badge.evaluate(node => node.parentElement.style.setProperty("--movie-rating-size", "32px"));
        assert.deepEqual(await badge.evaluate(node => [node.offsetWidth, node.offsetHeight]), [32, 32]);
    } finally {
        await page.close();
    }
}

reviewMovieProfiles(check).then(() => console.log("Age rating badge mappings, names and ring styles passed."))
    .catch(error => { console.error(error); process.exitCode = 1; });
