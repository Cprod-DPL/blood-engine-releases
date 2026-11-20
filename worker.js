"use strict";
// One AI worker for web/blood.js: the game's own module, headless. It runs
// `blood_job_run` (src/web.rs) on a battle sent as bytes and returns the answer.
// Only the clock is real; every other import (graphics, audio) is a no-op.

const stub = new Proxy({ blood_now: () => performance.now() }, { get: (t, k) => t[k] || (() => 0) });
let ready = null;

onmessage = (e) => {
  const m = e.data;
  if (m.module) {
    ready = WebAssembly.instantiate(m.module, { env: stub }).then((i) => i.exports);
    return;
  }
  ready.then((ex) => {
    try {
      const n = m.input.length;
      const p = ex.allocate_vec_u8(n);
      new Uint8Array(ex.memory.buffer, p, n).set(m.input);
      const len = ex.blood_job_run(m.kind, p, n);
      postMessage({ out: new Uint8Array(ex.memory.buffer, ex.blood_out(), len).slice() });
    } catch (_) {
      postMessage({ out: null, trapped: true });
    }
  }, () => postMessage({ out: null, trapped: true }));
};
