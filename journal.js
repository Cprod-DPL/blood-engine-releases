"use strict";
// localStorage updates are synchronous to the page, but Chromium can lose its
// latest batch when the browser process is killed. The relay ACK waits for the
// strict transaction, not just the localStorage write. No timer or polling.
const bloodJournal = (() => {
  const keys = ["online-a.sav", "online-b.sav", "online-slot.txt", "online-room.txt"].map(
    (k) => "be:BloodEngine/" + k,
  );
  const dirty = new Map();
  const measure =
    ["localhost", "127.0.0.1"].includes(location.hostname) && location.search.includes("battle-check");
  const samples = [];
  let db,
    pending = Promise.resolve(true);
  function open() {
    return new Promise((resolve) => {
      let req;
      try {
        req = indexedDB.open("BloodEngine-online", 1);
      } catch {
        resolve();
        return;
      }
      req.onupgradeneeded = () => req.result.createObjectStore("journal");
      req.onerror = req.onblocked = () => resolve();
      req.onsuccess = () => {
        db = req.result;
        db.onversionchange = () => {
          db.close();
          db = undefined;
        };
        const tx = db.transaction("journal"),
          store = tx.objectStore("journal");
        for (const key of keys) {
          const r = store.get(key);
          r.onsuccess = () => {
            if (r.result === undefined) return;
            if (r.result === null) localStorage.removeItem(key);
            else localStorage.setItem(key, r.result);
          };
        }
        tx.oncomplete = tx.onabort = () => resolve();
      };
    });
  }
  function flush() {
    if (!dirty.size) return pending;
    const writes = Array.from(dirty);
    dirty.clear();
    // Transactions on a single store execute in creation order. Sampling is
    // confined to the localhost verification harness.
    const start = measure ? performance.now() : 0;
    pending = new Promise((resolve) => {
      try {
        const tx = db.transaction("journal", "readwrite", { durability: "strict" });
        if (tx.durability !== "strict") {
          tx.abort();
          resolve(false);
          return;
        }
        const store = tx.objectStore("journal");
        for (const [key, value] of writes) store.put(value, key);
        tx.oncomplete = () => {
          if (measure && samples.length < 2048) samples.push(performance.now() - start);
          resolve(true);
        };
        tx.onabort = tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
    return pending;
  }
  function changed(key, value) {
    if (!keys.includes(key)) return true;
    if (!db) return false;
    dirty.set(key, value);
    if (dirty.size === 1) queueMicrotask(flush);
    return true;
  }
  function stats() {
    const v = samples.slice().sort((a, b) => a - b);
    return v.length
      ? {
          count: v.length,
          mean_ms: v.reduce((a, b) => a + b) / v.length,
          p95_ms: v[Math.ceil(v.length * 0.95) - 1],
        }
      : null;
  }
  return { open, changed, flush, stats };
})();
