"use strict";

for (const shelf of document.querySelectorAll(".cover-shelf")) {
  const track = shelf.querySelector(".shelf-track");
  const previous = shelf.querySelector(".previous"), next = shelf.querySelector(".next");
  const touch = matchMedia("(hover: none), (pointer: coarse)");
  function updateEdges() {
    const left = !touch.matches && track.scrollLeft > 1;
    const right = !touch.matches && track.scrollLeft + track.clientWidth < track.scrollWidth - 1;
    const active = document.activeElement;
    if (left) previous.hidden = false;
    if (right) next.hidden = false;
    if (active === previous && !left) (right ? next : track).focus({preventScroll:true});
    if (active === next && !right) (left ? previous : track).focus({preventScroll:true});
    previous.hidden = !left;
    next.hidden = !right;
  }
  for (const [button, direction] of [[previous, -1], [next, 1]]) {
    button.addEventListener("click", () => track.scrollBy({
      left:direction * Math.max(track.clientWidth - (track.firstElementChild?.offsetWidth || 0), track.clientWidth / 2),
      behavior:reducedMotion.matches ? "instant" : "smooth"
    }));
  }
  track.addEventListener("scroll", updateEdges, {passive:true});
  touch.addEventListener("change", updateEdges);
  new ResizeObserver(updateEdges).observe(track);
  new MutationObserver(updateEdges).observe(track, {childList:true});
}

(() => {
  const section = $("discovery"), track = $("release-list"), message = $("discovery-message");
  let request = 0;
  function releaseCard(item) {
    const title = displaySongTitle(item.title);
    const play = el("button", {type:"button", class:"cover-play", "aria-label":"Play " + title}, playerIcon("play"));
    const dismiss = el("button", {type:"button", class:"cover-dismiss", "aria-label":"Dismiss " + title}, playerIcon("close"));
    const art = el("div", {class:"release-art"}, cover(item), play, dismiss);
    const card = el("article", {class:"release-card"}, art, el("strong", {title}, title), el("span", {}, item.artist));
    const base = "/api/discovery/" + encodeURIComponent(item.id);
    let busy = false;
    play.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      try {
        const {query} = await api(base + "/play", {method:"POST", json:{}});
        if (!card.isConnected || section.closest("[hidden]")) return;
        $("q").value = query;
        $("clear-search").hidden = false;
        $("search-form").requestSubmit();
      } catch { message.textContent = "Could not find recordings. Select Play to try again."; }
      finally { busy = false; }
    });
    dismiss.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      try {
        await api(base + "/state", {method:"POST", json:{state:"dismissed"}});
        if (card.contains(document.activeElement) || (track.childElementCount === 1 && section.contains(document.activeElement))) {
          const neighbour = card.nextElementSibling || card.previousElementSibling;
          (neighbour?.querySelector(".cover-dismiss") || $("view-title")).focus();
        }
        card.remove();
        section.hidden = !track.childElementCount;
        message.textContent = "";
      } catch { message.textContent = "Could not dismiss this release. Try again."; }
      finally { busy = false; }
    });
    return card;
  }
  async function loadReleases() {
    const version = ++request;
    try {
      const {items} = await api("/api/discovery");
      if (version !== request) return;
      if (track.contains(document.activeElement)) (items.length ? track : $("view-title")).focus();
      track.replaceChildren(...items.map(releaseCard));
      section.hidden = !items.length;
      message.textContent = "";
    } catch {
      section.hidden = false;
      message.textContent = "Could not load releases. Select Refresh to try again.";
    }
  }
  $("refresh-library").addEventListener("click", loadReleases);
  loadReleases();
})();
