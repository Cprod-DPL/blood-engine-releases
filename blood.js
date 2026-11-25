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
  window.addEventListener("pagehide", () => { if (typeof wasm_exports !== "undefined") wasm_exports?.blood_climb_hide?.(); });
  const PREFIX = "be:";
  // One active game socket; stale events never reach a replacement room.
  const sockets = new Map();
  const socketEnv = {
    blood_ws_port: () => ["127.0.0.1","localhost"].includes(location.hostname) ? Number(new URLSearchParams(location.search).get("lobby-port"))||0 : 0,
    blood_ws_manual: () => ["127.0.0.1","localhost"].includes(location.hostname)&&new URLSearchParams(location.search).has("manual-lobby")?1:0,
    blood_ws_clock: () => performance.now(),
    blood_ws_review: p => {
      if (!["127.0.0.1","localhost"].includes(location.hostname)) return 0;
      const code=new URLSearchParams(location.search).get("battle-check")||"";
      if (code!=="resume" && !/^[A-HJ-NP-Z2-9]{6}$/.test(code)) return 0;
      view(p,6).set(enc.encode(code)); return 6;
    },
    blood_ws_open: (p,n) => {
      const id = nextId++, ws = new WebSocket(str(p,n)), q = [];
      ws.binaryType = "arraybuffer"; sockets.set(id,{ws,q});
      ws.onmessage = e => {
        if (!(e.data instanceof ArrayBuffer) || e.data.byteLength > 65536) { ws.close(); return; }
        const bytes=new Uint8Array(e.data);
        if(bytes.length===1&&bytes[0]===72){ws.send(Uint8Array.of(73));return;} // also answer in a background tab
        if(bytes.length===1 && bytes[0]===75 && q.some(old=>old.length===1&&old[0]===75))return;
        if(q.length>=32){ws.close();return;}
        q.push(bytes);
      };
      ws.onclose = () => q.push(new Uint8Array()); return id;
    },
    blood_ws_send: (id,p,n) => {
      const ws=sockets.get(id)?.ws;
      if (ws?.readyState!==WebSocket.OPEN || ws.bufferedAmount>4096) return 0;
      const bytes=view(p,n);
      if((n===14 && bytes[0]===2) || bytes[0]===19 || bytes[0]===23 || bytes[0]===81 || bytes[0]===85 || bytes[0]===66){
        const ack=bytes.slice();
        bloodJournal.flush().then(ok=>{
          if(ws.readyState!==WebSocket.OPEN)return;
          if(ok)ws.send(ack);else{ws.send(Uint8Array.of(69));}
        });
      }else ws.send(bytes);
      return 1;
    },
    blood_ws_size: id => sockets.get(id)?.q[0]?.length ?? -1,
    blood_ws_poll: (id,p) => {
      const b=sockets.get(id)?.q.shift(); if (!b) return -1;
      view(p,b.length).set(b); return b.length;
    },
    blood_ws_close: id => {const s=sockets.get(id); if(s){s.ws.close(); sockets.delete(id);}},
  };

  // Stage only the latest committed position in memory. Leaving the page saves it;
  // an ordinary resume consumes the stored game before input is enabled.
  const adventureKey = PREFIX + "BloodEngine/adventure.sav";
  let adventure = "";
  window.addEventListener("pagehide", () => {
    if (adventure) localStorage.setItem(adventureKey, adventure);
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && adventure && localStorage.getItem(adventureKey) === adventure)
      localStorage.removeItem(adventureKey);
  });

  // AI workers run the same module. Worker 0 takes only the battle's plans
  // (the enemy never waits behind a win-chance playout or a background
  // tournament match, group 1); the rest take plans, then those, then playouts.
  let module = null;
  const pool = [];
  const plans = [], later = [], playouts = [];
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
      const job = plans.shift() || (i > 0 ? later.shift() || playouts.shift() : undefined);
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
    blood_adventure_stage: (p, n) => { adventure = str(p, n); },

    blood_store_get: (k, kl) => {
      const v = localStorage.getItem(PREFIX + str(k, kl));
      return v === null ? -1 : park(enc.encode(v));
    },
    blood_store_set: (k, kl, v, vl) => {
      try { const key=PREFIX+str(k,kl), value=str(v,vl); if(!bloodJournal.changed(key,value))return 0;localStorage.setItem(key,value);return 1; } catch (_) { return 0; }
    },
    blood_store_del: (k, kl) => {const key=PREFIX+str(k,kl);bloodJournal.changed(key,null);localStorage.removeItem(key);},
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
      (kind === 3 ? later : kind === PLAN ? (group ? later : plans) : playouts).push({ id, kind, group, input: view(p, l).slice() });
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

  miniquad_add_plugin({ register_plugin: (o) => Object.assign(o.env, env, socketEnv), name: "blood", version: 1 });

  // gl.js's load(), compiling once so the workers share the module.
  window.blood_load = (url) => {
    register_plugins(plugins);
    Promise.all([WebAssembly.compileStreaming(fetch(url)),bloodJournal.open()])
      .then(([m]) => {
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
