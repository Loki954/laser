// Grbl_ESP32 / SculpFun protocol: commands, status, SD upload ([ESP486]) and run ([ESP220]), streaming.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const enc = new TextEncoder();

export class Machine {
  constructor() {
    this.t = null;
    this.listeners = {};
    this.dec = new TextDecoder();
    this.buf = '';
    this.waiters = [];       // pending 'ok'/'error' resolvers (FIFO)
    this.uploading = false;
    this.streaming = null;
    this.status = { state: 'Disconnected', wpos: [0, 0], mpos: [0, 0], wco: [0, 0], feed: 0, power: 0, sd: null };
    this.info = {};
    this.autoUnlock = true;
    this.jobActive = false;
    this.cmdChain = Promise.resolve();
  }
  on(ev, cb) { (this.listeners[ev] ||= []).push(cb); }
  emit(ev, data) { (this.listeners[ev] || []).forEach(cb => { try { cb(data); } catch (e) { console.error(e); } }); }
  get connected() { return !!(this.t && this.t.connected); }

  async attach(t) {
    if (this.t) await this.detach();
    this.t = t;
    t.onData((bytes) => this._rx(bytes));
    t.onClose(() => this._closed());
    await t.connect(...(this._connectArgs || []));
    this.status.state = 'Connected';
    this.emit('connected', t.name);
    this.emit('status', this.status);
    this.poll = setInterval(() => this._poll(), 1000);
    await sleep(300);
    this.send('$I').catch(() => { });
  }
  async detach() { const t = this.t; if (t) await t.disconnect(); }
  _closed() {
    clearInterval(this.poll);
    this.t = null;
    this.waiters.splice(0).forEach(w => w.reject(new Error('Disconnected')));
    this.status.state = 'Disconnected';
    this.uploading = false; this.streaming = null; this.jobActive = false;
    this.emit('disconnected');
    this.emit('status', this.status);
  }
  _poll() { if (this.connected && !this.uploading && !this.pausePoll) this.t.write('?').catch(() => { }); }

  _rx(bytes) {
    this.buf += this.dec.decode(bytes, { stream: true });
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r/g, '').trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this._line(line);
    }
    // status reports sometimes arrive without newline at the very end
    if (this.buf.startsWith('<') && this.buf.includes('>')) {
      const j = this.buf.indexOf('>');
      this._line(this.buf.slice(0, j + 1)); this.buf = this.buf.slice(j + 1);
    }
  }
  _line(line) {
    if (line.startsWith('<') && line.endsWith('>')) { this._parseStatus(line); this.emit('raw-status', line); return; }
    this.emit('line', { dir: 'in', text: line });
    const low = line.toLowerCase();
    if (low === 'ok' || low.endsWith(' ok') || (this.uploading && low.includes('ok'))) {
      const w = this.waiters.shift(); if (w) w.resolve('ok');
      if (this.streaming) this.streaming.ack();
      return;
    }
    if (low.startsWith('error')) {
      const w = this.waiters.shift(); if (w) w.reject(new Error(line));
      if (this.streaming) this.streaming.ack(line);
      this.emit('error', line);
      return;
    }
    if (low.startsWith('alarm')) { this.emit('alarm', line); return; }
    let m;
    if ((m = line.match(/^\[VER:(.*)\]$/))) this.info.version = m[1];
    if ((m = line.match(/\[MSG:\s*Mechine:?\s*(.*)\]/i))) this.info.model = m[1];
    if (/\[MSG:/.test(line)) this.emit('msg', line);
  }
  _parseStatus(s) {
    const parts = s.slice(1, -1).split('|');
    const st = this.status;
    st.state = parts[0].split(':')[0];
    st.sd = null;
    for (const p of parts.slice(1)) {
      const [k, v] = p.split(':');
      if (!v) continue;
      const n = v.split(',').map(Number);
      if (k === 'MPos') { st.mpos = n; st.wpos = [n[0] - st.wco[0], n[1] - st.wco[1]]; }
      else if (k === 'WPos') { st.wpos = n; st.mpos = [n[0] + st.wco[0], n[1] + st.wco[1]]; }
      else if (k === 'WCO') { st.wco = n; st.wpos = [st.mpos[0] - n[0], st.mpos[1] - n[1]]; }
      else if (k === 'FS') { st.feed = n[0]; st.power = n[1]; }
      else if (k === 'SD') { const sp = v.split(','); st.sd = { pct: parseFloat(sp[0]), file: sp.slice(1).join(',') }; }
    }
    if (st.state === 'Alarm' && this.autoUnlock && !this._unlocking) {
      this._unlocking = true; this.t.write('$X\n').finally(() => setTimeout(() => this._unlocking = false, 2000));
    }
    if (this.jobActive) {
      if (st.state === 'Run' || st.state === 'Hold' || st.sd) this._sawRun = true;
      if (st.sd) this.emit('progress', { phase: 'run', pct: st.sd.pct });
      if (this._sawRun && st.state === 'Idle' && !st.sd && !this.streaming) { this.jobActive = false; this._sawRun = false; this.emit('jobdone'); }
    }
    this.emit('status', st);
  }

  _expectOk(timeout = 8000) {
    return new Promise((resolve, reject) => {
      const w = { resolve: (v) => { clearTimeout(w.to); resolve(v); }, reject: (e) => { clearTimeout(w.to); reject(e); } };
      w.to = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('No answer from engraver (timeout)')); }, timeout);
      this.waiters.push(w);
    });
  }
  // Send one or more lines; each waits for ok. Serialised so answers line up.
  send(cmd, timeout = 8000) {
    const lines = String(cmd).split('\n').map(l => l.trim()).filter(Boolean);
    const run = async () => {
      if (!this.connected) throw new Error('Not connected');
      let last;
      for (const l of lines) {
        this.emit('line', { dir: 'out', text: l });
        const p = this._expectOk(timeout);
        await this.t.write(l + '\n');
        last = await p;
      }
      return last;
    };
    const p = this.cmdChain.then(run, run);
    this.cmdChain = p.catch(() => { });
    return p;
  }
  realtime(ch) {
    if (!this.connected) return;
    this.emit('line', { dir: 'out', text: ch === '\x18' ? '[reset]' : ch.charCodeAt(0) >= 0x80 ? '[0x' + ch.charCodeAt(0).toString(16) + ']' : ch });
    return this.t.write(typeof ch === 'string' && ch.charCodeAt(0) >= 0x80 ? new Uint8Array([ch.charCodeAt(0)]) : ch);
  }
  // Wait until the machine has finished moving. Asks for fresh status reports so an old "Idle" isn't trusted.
  async waitIdle(timeout = 120000) {
    const t0 = Date.now();
    let idleCount = 0, seenBusy = false;
    while (Date.now() - t0 < timeout) {
      if (this.connected) await this.t.write('?').catch(() => { });
      await sleep(300);
      const st = this.status.state;
      if (st === 'Idle') idleCount++; else { idleCount = 0; seenBusy = true; }
      if (idleCount >= (seenBusy ? 1 : 3) && Date.now() - t0 > 600) return true;
    }
    return false;
  }

  // ---------- jobs ----------
  async uploadAndRun(name, gcode, { setOrigin = true, absolute = false, offset = [0, 0] } = {}) {
    const data = enc.encode(gcode);
    this.uploading = true;
    this.cancelUpload = false;
    try {
      await sleep(400);
      this.waiters.splice(0).forEach(w => w.reject(new Error('reset')));
      this.emit('progress', { phase: 'upload', pct: 0 });
      this.emit('line', { dir: 'out', text: `[ESP486]/${name}` });
      let p = this._expectOk(6000);
      await this.t.write(`[ESP486]/${name}\n`);
      await p;
      const L = data.length;
      p = this._expectOk(6000);
      await this.t.write(new Uint8Array([0x0a, 0xa0, (L >>> 24) & 255, (L >>> 16) & 255, (L >>> 8) & 255, L & 255]));
      await p;
      let sent = 0, last = 0;
      const CH = 4096;
      while (sent < L) {
        if (this.cancelUpload) throw new Error('Upload cancelled');
        const part = data.subarray(sent, Math.min(L, sent + CH));
        const gap = Date.now() - last; if (gap < 70) await sleep(70 - gap);
        last = Date.now();
        p = this._expectOk(30000);
        await this.t.write(part);
        await p;
        sent += part.length;
        this.emit('progress', { phase: 'upload', pct: (sent / L) * 100 });
      }
      p = this._expectOk(10000);
      await this.t.write(new Uint8Array([0xa0, 0x0a]));
      await p;
    } finally {
      this.uploading = false;
    }
    this.emit('line', { dir: 'in', text: `Uploaded ${data.length} bytes` });
    await sleep(300);
    if (absolute || setOrigin) await this.send(this.originCmd({ absolute, offset }));
    this.jobActive = true; this._sawRun = false;
    await this.send(`[ESP220]/${name}`);
    this.emit('progress', { phase: 'run', pct: 0 });
  }

  // Character-counting streaming (fallback when SD upload is not available)
  async stream(gcode, { setOrigin = true, absolute = false, offset = [0, 0], rxBuffer = 120 } = {}) {
    if (absolute || setOrigin) await this.send(this.originCmd({ absolute, offset }));
    await this.cmdChain;
    const lines = gcode.split('\n').map(l => l.replace(/;.*$/, '').trim()).filter(Boolean);
    const inflight = [];
    let used = 0, done = 0, err = null;
    let wake = null;
    const st = {
      cancelled: false,
      ack: (e) => { const n = inflight.shift(); if (n) used -= n; done++; if (e) err = e; if (wake) { const w = wake; wake = null; w(); } },
    };
    this.streaming = st; this.jobActive = true; this._sawRun = true;
    try {
      for (let i = 0; i < lines.length; i++) {
        if (st.cancelled) throw new Error('Stopped');
        if (err) throw new Error('Engraver reported ' + err + ' at line ' + done);
        const l = lines[i] + '\n';
        while (used + l.length > rxBuffer && inflight.length) {
          await new Promise(r => { wake = r; setTimeout(r, 3000); });
          if (st.cancelled) throw new Error('Stopped');
        }
        inflight.push(l.length); used += l.length;
        await this.t.write(l);
        if (i % 20 === 0) this.emit('progress', { phase: 'run', pct: (i / lines.length) * 100 });
      }
      while (inflight.length && !st.cancelled) await new Promise(r => { wake = r; setTimeout(r, 3000); });
    } finally {
      this.streaming = null;
    }
    this.emit('progress', { phase: 'run', pct: 100 });
  }

  // Set the job origin: the laser beam, or a red pointer that sits offset from the beam by [dx, dy] mm
  originCmd({ absolute = false, offset = [0, 0] } = {}) {
    if (absolute) return 'G92.1';
    const [dx, dy] = offset || [0, 0];
    return `G92 X${(-dx || 0).toFixed(2)} Y${(-dy || 0).toFixed(2)}`;
  }

  pause() { return this.realtime('!'); }
  resume() { return this.realtime('~'); }
  async stop() {
    this.cancelUpload = true;
    if (this.streaming) this.streaming.cancelled = true;
    this.jobActive = false;
    await this.realtime('!');
    await sleep(150);
    await this.realtime('\x18');
    await sleep(800);
    try { await this.t.write('$X\nM5\n'); } catch (e) { }
    this.waiters.splice(0).forEach(w => w.reject(new Error('Stopped')));
    this.emit('jobdone', { stopped: true });
  }

  jog(dx, dy, feed) {
    const p = [];
    if (dx) p.push('X' + dx.toFixed(3));
    if (dy) p.push('Y' + dy.toFixed(3));
    if (!p.length) return;
    return this.send(`$J=G91 G21 ${p.join(' ')} F${feed}`);
  }

  // Show where the job goes. With the laser: a weak visible beam (like the original app).
  // With a red pointer: laser stays off and the head is shifted so the pointer draws the outline.
  async frame(b, { power = 3, feed = 3000, absolute = false, offset = [0, 0], pointer = false } = {}) {
    const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1], [b.x0, b.y0]];
    return this.trace(pts, { power, feed, absolute, offset, pointer, closed: false });
  }
  async trace(pts, { power = 3, feed = 3000, absolute = false, offset = [0, 0], pointer = false, closed = true } = {}) {
    if (!pts.length) return;
    const [dx, dy] = pointer ? (offset || [0, 0]) : [0, 0];
    const f = (v) => v.toFixed(2);
    this.cancelFrame = false;
    const path = closed ? pts.concat([pts[0]]) : pts;
    // Normal G-code moves: the firmware turns the beam on only while moving and runs everything in order.
    const lines = [this.originCmd({ absolute, offset: pointer ? [dx, dy] : [0, 0] }), 'G90 G21', `G0 X${f(path[0][0] - dx)} Y${f(path[0][1] - dy)}`];
    if (!pointer) lines.push(`M3 S${power}`);
    path.slice(1).forEach((p, i) => lines.push(`G1 X${f(p[0] - dx)} Y${f(p[1] - dy)}` + (pointer ? '' : ` S${power}`) + (i === 0 ? ` F${feed}` : '')));
    if (!pointer) lines.push('M5');
    lines.push(`G0 X${f(-dx)} Y${f(-dy)}`);
    for (const l of lines) {
      if (this.cancelFrame) return;
      await this.send(l, 60000);
    }
    await this.waitIdle(180000);
  }
  // Draw several paths with the weak beam (G0 between paths = beam off)
  async tracePaths(paths, { power = 3, feed = 3000, absolute = false, offset = [0, 0], pointer = false } = {}) {
    if (!paths.length) return;
    const [dx, dy] = pointer ? (offset || [0, 0]) : [0, 0];
    const f = (v) => v.toFixed(2);
    this.cancelFrame = false;
    const lines = [this.originCmd({ absolute, offset: pointer ? [dx, dy] : [0, 0] }), 'G90 G21'];
    if (!pointer) lines.push(`M3 S0`);
    let first = true;
    for (const p of paths) {
      const pts = p.closed ? p.pts.concat([p.pts[0]]) : p.pts;
      lines.push(`G0 X${f(pts[0][0] - dx)} Y${f(pts[0][1] - dy)}`);
      pts.slice(1).forEach((q, i) => {
        lines.push(`G1 X${f(q[0] - dx)} Y${f(q[1] - dy)}` + (pointer || i ? '' : ` S${power}`) + (first ? ` F${feed}` : ''));
        first = false;
      });
    }
    if (!pointer) lines.push('M5');
    lines.push(`G0 X${f(-dx)} Y${f(-dy)}`);
    for (const l of lines) {
      if (this.cancelFrame) return;
      await this.send(l, 60000);
    }
    await this.waitIdle(600000);
  }
  async stopMotion() {
    this.cancelFrame = true;
    await this.realtime('!');
    await sleep(200);
    await this.realtime('\x18');
    await sleep(900);
    this.waiters.splice(0).forEach(w => w.reject(new Error('Stopped')));
    try { await this.t.write('$X\nM5\n'); } catch (e) { }
  }
}
