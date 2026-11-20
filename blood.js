"use strict";
// Blood Engine's browser side, for src/web.rs: storage, the AI workers, fetch,
// clipboard, text entry and updates. Loaded after mq.js (miniquad's gl.js and
// quad-snd's audio.js), whose globals it uses: plugins, importObject,
// wasm_memory, wasm_exports.

(() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const view = (p, n) => new Uint8Array(wasm_memory.buffer, p, n);
  const str = (p, n) => dec.decode(view(p, n).slice());

  // A synchronous answer of unknown length waits here for `blood_take`.
  let parked = new Uint8Array(0);
  const park = (u8) => { parked = u8; return u8.length; };

  // Asynchronous answers by id: status -1 pending, -2 failed, else length.
  const results = new Map();
  let nextId = 1;
  const begin = () => { const id = nextId++; results.set(id, { status: -1, out: null }); return id; };
  const finish = (id, out) => { const r = results.get(id); if (r) { r.status = out ? out.length : -2; r.out = out; } };

  // Storage: the game's paths are keys under one prefix.
  const PREFIX = "be:";

  // AI workers run the same module. Worker 0 takes only plans (the enemy
  // never waits behind a win-chance playout); the rest take plans first.
  let module = null;
  const pool = [];
  const plans = [], playouts = [];
  const PLAN = 1;

  function spawn(i) {
    const w = new Worker("worker.js?v=" + BLOOD_VERSION);
    w.onmessage = (e) => settle(i, e.data.out, e.data.trapped);
    w.onerror = (e) => { e.preventDefault(); settle(i, null, true); };
    w.postMessage({ module });
    pool[i] = { w, job: null };
  }

  function settle(i, out, trapped) {
    const s = pool[i];
    if (s.job) finish(s.job.id, out);
    s.job = null;
    // A trapped instance may be half-written: replace it.
    if (trapped) { s.w.terminate(); spawn(i); }
    dispatch();
  }

  function dispatch() {
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (s.job) continue;
      const job = plans.shift() || (i > 0 ? playouts.shift() : undefined);
      if (!job) continue;
      s.job = job;
      s.w.postMessage({ kind: job.kind, input: job.input }, [job.input.buffer]);
    }
  }

  let updateReady = false;
  function checkUpdate() {
    fetch("version.txt", { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((v) => { v = v.trim(); if (v && v !== BLOOD_VERSION) updateReady = true; }, () => {});
  }

  const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

  const env = {
    blood_now: () => performance.now(),

    blood_store_get: (k, kl) => {
      const v = localStorage.getItem(PREFIX + str(k, kl));
      return v === null ? -1 : park(enc.encode(v));
    },
    blood_store_set: (k, kl, v, vl) => {
      try { localStorage.setItem(PREFIX + str(k, kl), str(v, vl)); return 1; } catch (_) { return 0; }
    },
    blood_store_del: (k, kl) => localStorage.removeItem(PREFIX + str(k, kl)),
    blood_store_keys: (p, pl) => {
      const pre = PREFIX + str(p, pl);
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k.startsWith(pre)) out.push(k.slice(PREFIX.length));
      }
      return park(enc.encode(out.join("\n")));
    },
    blood_take: (dst) => { view(dst, parked.length).set(parked); parked = new Uint8Array(0); },

    blood_prompt: (m, ml, d, dl) => {
      const v = window.prompt(str(m, ml), str(d, dl));
      return v === null ? -1 : park(enc.encode(v));
    },

    blood_job: (kind, group, p, l) => {
      const id = begin();
      (kind === PLAN ? plans : playouts).push({ id, kind, group, input: view(p, l).slice() });
      if (module) dispatch();
      return id;
    },
    blood_job_cancel: (group) => {
      for (let i = playouts.length - 1; i >= 0; i--) {
        if (playouts[i].group === group) { finish(playouts[i].id, null); playouts.splice(i, 1); }
      }
    },

    blood_fetch: (u, ul) => {
      const id = begin();
      fetch(str(u, ul), { signal: timeout(15000) })
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => finish(id, b && b.byteLength <= 65536 ? new Uint8Array(b) : null), () => finish(id, null));
      return id;
    },
    blood_post: (u, ul, n, nl, f, fl, b, bl) => {
      const id = begin();
      const form = new FormData();
      form.append("name", str(n, nl));
      form.append("file", new Blob([str(b, bl)], { type: "text/plain" }), str(f, fl));
      fetch(str(u, ul), { method: "POST", body: form, signal: timeout(20000) })
        .then((r) => finish(id, r.ok ? new Uint8Array(0) : null), () => finish(id, null));
      return id;
    },
    // The clipboard if the browser allows it, else the device's paste box.
    blood_paste: () => {
      const id = begin();
      const ask = () => finish(id, enc.encode(window.prompt("Paste a replay or its link") || ""));
      if (navigator.clipboard && navigator.clipboard.readText) {
        navigator.clipboard.readText().then((t) => (t ? finish(id, enc.encode(t)) : ask()), ask);
      } else ask();
      return id;
    },

    blood_poll: (id) => {
      const r = results.get(id);
      if (!r) return -2;
      if (r.status === -2) results.delete(id);
      return r.status;
    },
    blood_result: (id, dst) => {
      const r = results.get(id);
      if (r && r.out) view(dst, r.out.length).set(r.out);
      results.delete(id);
    },

    blood_update_ready: () => (updateReady ? 1 : 0),
    blood_reload: () => location.reload(),
    // An installed app closes; a browser tab that cannot goes back to where
    // the player came from.
    blood_quit: () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      window.close();
      setTimeout(() => { if (history.length > 1) history.back(); }, 150);
    },
  };

  miniquad_add_plugin({ register_plugin: (o) => Object.assign(o.env, env), name: "blood", version: 1 });

  // gl.js's load(), compiling once so the workers share the module.
  window.blood_load = (url) => {
    register_plugins(plugins);
    WebAssembly.compileStreaming(fetch(url))
      .then((m) => {
        module = m;
        const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
        for (let i = 0; i < n; i++) spawn(i);
        dispatch();
        add_missing_functions_stabs(m);
        return WebAssembly.instantiate(m, importObject);
      })
      .then((inst) => {
        wasm_memory = inst.exports.memory;
        wasm_exports = inst.exports;
        init_plugins(plugins);
        document.getElementById("loading").remove();
        inst.exports.main();
      })
      .catch((e) => {
        console.error(e);
        document.getElementById("loading").textContent = "This browser cannot run Blood Engine";
      });
    checkUpdate();
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  };
})();
