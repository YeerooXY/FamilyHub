"use strict";

(() => {
  const panel = $("connect-panel"), summary = $("output-summary"), details = $("output-details");
  const volume = $("connect-volume"), localVolume = $("volume"), list = $("device-list");
  const feedback = $("connect-message"), bluetooth = $("connect-bluetooth");
  const phone = matchMedia("(max-width: 720px)");
  const deviceGlyph = kind => ["android", "iphone", "ipad"].includes(kind) ? "phone" : "laptop";
  const localLabel = () => ["iphone", "android"].includes(deviceKind) ? "This phone" : deviceKind === "ipad" ? "This iPad" : "This computer";
  const localDevice = () => ({id:deviceId, kind:deviceKind, name:localLabel(), track:currentTrack, playing:!idleHere()});
  let opener, shownId, rowsSignature;
  const settingsUrl = {windows:"ms-settings:bluetooth", android:"intent:#Intent;action=android.settings.BLUETOOTH_SETTINGS;end"}[deviceKind];
  if (settingsUrl) {
    $("bluetooth-settings").href = settingsUrl;
    $("bluetooth-settings").hidden = false;
  }

  function volumeValue() {
    volume.value = localVolume.value;
    volume.style.setProperty("--volume-fill", (100 * Number(volume.value)) + "%");
  }
  volume.addEventListener("input", () => {
    if (!remoteBar.hidden) return;
    localVolume.value = volume.value;
    localVolume.dispatchEvent(new Event("input"));
  });
  volume.addEventListener("change", () => localVolume.dispatchEvent(new Event("change")));
  localVolume.addEventListener("input", volumeValue);

  function closeDetails() {
    if (details.contains(document.activeElement)) summary.focus();
    summary.setAttribute("aria-expanded", "false");
    details.hidden = true;
    details.replaceChildren();
  }
  function render() {
    if (!panel.open) return;
    const local = localDevice();
    const output = !remoteBar.hidden && remoteDevice ? remoteDevice : local;
    const isLocal = output.id === deviceId;
    if (shownId !== output.id) {
      closeDetails();
      shownId = output.id;
      summary.querySelector(".output-symbol").replaceChildren(playerIcon(deviceGlyph(output.kind)));
    }
    $("output-name").textContent = output.name;
    summary.setAttribute("aria-label", "Current output: " + output.name + ". Output details");
    const artist = output.track?.channel || output.track?.artist;
    const song = [displaySongTitle(output.track?.title), artist].filter(Boolean).join(" – ");
    $("output-song").hidden = !song;
    $("output-song").lastElementChild.textContent = song;
    $("output-song").classList.toggle("paused", output.status === "paused" || (isLocal && idleHere()));
    const hls = decks[deckIndex].hls;
    const bitrate = isLocal && hls?.levels?.[hls.currentLevel]?.bitrate;
    const quality = output.quality || (bitrate ? Math.round(bitrate / 1000) + " kbps" : "");
    $("output-quality").textContent = quality;
    $("output-quality").hidden = !quality;
    if (!isLocal && document.activeElement === volume) summary.focus();
    $("output-volume").hidden = !isLocal;
    volumeValue();
    const others = [local, ...onlineDevices.filter(d => d.id !== deviceId)].filter(d => d.id !== output.id);
    const signature = JSON.stringify(others.map(d => [d.id, d.name, d.kind, d.playing, d.track?.title]));
    if (signature !== rowsSignature) {
      const activeId = list.contains(document.activeElement) && document.activeElement.dataset.id;
      const rows = others.map(device => {
        const copy = el("span", {}, el("strong", {}, device.id === deviceId ? "Play here" : device.name));
        if (device.id === deviceId) copy.append(el("small", {}, localLabel()));
        if (device.playing && device.track) copy.append(el("small", {}, playerIcon("equaliser"), displaySongTitle(device.track.title)));
        const button = el("button", {type:"button", class:"device-row", "data-id":device.id}, playerIcon(deviceGlyph(device.kind)), copy);
        return button;
      });
      list.replaceChildren(...rows);
      if (activeId) (rows.find(row => row.dataset.id === activeId) || summary).focus();
      rowsSignature = signature;
    }
    for (const row of list.children) row.setAttribute("aria-disabled", String(Boolean(handoff)));
    if (handoff && !feedback.textContent.startsWith("Connecting...")) notice(feedback, "Connecting...");
  }
  document.addEventListener("playbackdeviceschange", render);
  function showPanel() {
    if (phone.matches) panel.showModal();
    else panel.show();
  }
  $("connect-open").addEventListener("click", event => {
    if (panel.open) { panel.close(); return; }
    opener = event.currentTarget;
    notice(feedback, "");
    showPanel();
    render();
    refreshRemotePlayback();
  });
  phone.addEventListener("change", () => {
    if (!panel.open) return;
    const active = document.activeElement;
    panel.close();
    showPanel();
    if (panel.contains(active) && active.getClientRects().length) active.focus();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && panel.open && !phone.matches) panel.close();
  });
  $("connect-close").addEventListener("click", () => panel.close());
  panel.addEventListener("click", event => {
    if (event.target !== panel) return;
    const box = panel.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) panel.close();
  });
  panel.addEventListener("close", () => {
    if (panel.open) return;
    closeDetails();
    $("bluetooth-help").hidden = true;
    bluetooth.setAttribute("aria-expanded", "false");
    if (document.activeElement !== document.body && !panel.contains(document.activeElement)) return;
    const target = opener?.getClientRects().length ? opener : remoteBar.hidden ? $("connect-open") : $("remote-line");
    target.focus({preventScroll:true});
  });
  // Keep scrolling available in the list. Reserve the sheet header for the dismiss gesture.
  const grip = panel.querySelector(".connect-header");
  let drag = null;
  grip.addEventListener("pointerdown", event => {
    if (phone.matches && event.pointerType !== "mouse" && !event.target.closest("button")) {
      drag = {id:event.pointerId, y:event.clientY};
      grip.setPointerCapture(event.pointerId);
    }
  });
  grip.addEventListener("pointerup", event => {
    if (drag?.id === event.pointerId && event.clientY - drag.y >= 48) panel.close();
    drag = null;
  });
  grip.addEventListener("pointercancel", () => { drag = null; });

  list.addEventListener("click", event => {
    const target = event.target.closest("button")?.dataset.id;
    if (target) choosePlaybackDevice(target);
  });

  async function setSpeaker(id) {
    unlock();
    if (audioContext && nodes.length) {
      if (!audioContext.setSinkId) throw new Error();
      await audioContext.setSinkId(id);
    } else {
      await Promise.all(decks.map(deck => deck.setSinkId(id)));
    }
  }
  summary.addEventListener("click", async () => {
    if (!details.hidden) { closeDetails(); return; }
    details.hidden = false;
    summary.setAttribute("aria-expanded", "true");
    if (shownId !== deviceId) {
      details.textContent = "Control volume on " + $("output-name").textContent + ".";
      return;
    }
    details.textContent = "Choose a speaker in this device’s sound settings.";
    try {
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput" && d.deviceId);
      if (!panel.open || details.hidden || shownId !== deviceId || !outputs.length ||
          !(audioContext ? audioContext.setSinkId : decks[0].setSinkId)) return;
      const select = el("select", {"aria-label":"Speakers on this device"}, ...outputs.map((d, i) =>
        el("option", {value:d.deviceId}, d.label || "Speaker " + (i + 1))));
      select.value = audioContext?.sinkId || decks[0].sinkId || "default";
      select.addEventListener("change", async () => {
        try { await setSpeaker(select.value); }
        catch { notice(feedback, "The speaker could not be selected. Choose it in this device’s sound settings.", {level:"error"}); }
      });
      details.replaceChildren(el("label", {}, "Speakers on this device", select));
    } catch { /* System sound settings remain available. */ }
  });
  bluetooth.addEventListener("click", async () => {
    if (navigator.mediaDevices?.selectAudioOutput && remoteBar.hidden) {
      try {
        const device = await navigator.mediaDevices.selectAudioOutput();
        await setSpeaker(device.deviceId);
        notice(feedback, "Audio output updated.", {level:"success"});
        return;
      } catch (error) { if (error.name === "AbortError") return; }
    }
    const help = $("bluetooth-help");
    help.hidden = !help.hidden;
    bluetooth.setAttribute("aria-expanded", String(!help.hidden));
    if (!help.hidden) help.scrollIntoView({block:"nearest"});
  });
})();
