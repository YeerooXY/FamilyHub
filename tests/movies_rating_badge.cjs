const assert = require("node:assert/strict");
const {moviePage, reviewMovieProfiles} = require("./movies_fixture.cjs");

const cases = [
    ["KN", "KN", "no age limit"], [6, "6"], ["12", "12"], ["16", "16"], ["18", "18"],
    ["G", "6"], ["PG", "6"], ["PG-13", "12"], ["R", "16"], ["NC-17", "18"],
    ["TV-Y", "6"], ["TV-Y7", "6"], ["TV-G", "6"], ["TV-PG", "12"], ["TV-14", "16"], ["TV-MA", "18"],
    ["U", "6"], ["GB PG", "6"], ["12A", "12"], ["GB-15", "16"], [" hu-12 ", "12"],
    ["NR", null], ["Unrated", null], ["", null], [13, null], [null, null], [false, null]
];
const rings = {
    KN: "rgb(73, 214, 129)", 6: "rgb(73, 214, 129)", 12: "rgb(255, 218, 85)",
    16: "rgb(255, 154, 82)", 18: "rgb(255, 101, 115)"
};

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
        for (const [index, [raw, label, accessible = label]] of cases.entries()) {
            const wrapper = page.getByTestId(`rating-${index}`);
            const message = `${profile} ${JSON.stringify(raw)}`;
            if (!label) {
                assert.equal(await wrapper.locator("*").count(), 0, message);
                continue;
            }
            const badge = wrapper.getByRole("img", {name: `Rated ${accessible}`, exact: true});
            assert.equal(await badge.textContent(), label, message);
            assert.equal(await badge.getAttribute("data-level"), label, message);
            assert.deepEqual(await badge.evaluate(node => {
                const style = getComputedStyle(node);
                return [style.width, style.height, style.borderTopWidth, style.borderTopColor, style.borderRadius, style.backgroundColor];
            }), ["40px", "40px", "4px", rings[label], "50%", "rgb(21, 21, 28)"], message);
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
