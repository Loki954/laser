// Transports: Bluetooth Classic (SPP via Web Serial), Bluetooth LE (Web Bluetooth), Demo simulator.
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
const enc = new TextEncoder();
const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d);

class Base {
  constructor() { this._data = () => { }; this._close = () => { }; this.connected = false; }
  onData(cb) { this._data = cb; }
  onClose(cb) { this._close = cb; }
}

// ---------------- Bluetooth Classic (SPP) through the Web Serial API ----------------
export class SerialTransport extends Base {
  constructor() { super(); this.name = 'Bluetooth'; this.port = null; this.reader = null; this.writer = null; }
  static supported() { return 'serial' in navigator; }
  async connect() {
    if (!SerialTransport.supported()) throw new Error('This browser has no Web Serial. Use Chrome 138+ on Android.');
    let port;
    try {
      port = await navigator.serial.requestPort({
        filters: [{ bluetoothServiceClassId: SPP_UUID }],
        allowedBluetoothServiceClassIds: [SPP_UUID],
      });
    } catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'AbortError') throw new Error('No device chosen. Pair the engraver in Android Bluetooth settings first, then try again.');
      // older implementations may not accept the filter
      port = await navigator.serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
    }
    this.port = port;
    await port.open({ baudRate: 115200, bufferSize: 8192 });
    this.writer = port.writable.getWriter();
    this.connected = true;
    this._readLoop();
    navigator.serial.addEventListener('disconnect', (ev) => { if (ev.target === this.port) this._closed(); });
  }
  async _readLoop() {
    try {
      while (this.port && this.port.readable && this.connected) {
        this.reader = this.port.readable.getReader();
        try {
          for (; ;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) this._data(value);
          }
        } finally { try { this.reader.releaseLock(); } catch (e) { } }
      }
    } catch (e) { console.warn('serial read', e); }
    this._closed();
  }
  _closed() { if (!this.connected) return; this.connected = false; this._close(); }
  async write(d) { if (!this.writer) throw new Error('Not connected'); await this.writer.write(toBytes(d)); }
  async disconnect() {
    this.connected = false;
    try { await this.reader?.cancel(); } catch (e) { }
    try { this.writer?.releaseLock(); } catch (e) { }
    try { await this.port?.close(); } catch (e) { }
    this._close();
  }
}

// ---------------- Bluetooth Low Energy (Web Bluetooth) ----------------
const BLE_PROFILES = [
  { svc: '6e400001-b5a3-f393-e0a9-e50e24dcca9e', write: '6e400002-b5a3-f393-e0a9-e50e24dcca9e', notify: '6e400003-b5a3-f393-e0a9-e50e24dcca9e' },
  { svc: 0xfff0, write: 0xfff2, notify: 0xfff1 },
  { svc: 0xffe0, write: 0xffe1, notify: 0xffe1 },
];
export class BleTransport extends Base {
  constructor(chunk = 20) { super(); this.name = 'Bluetooth LE'; this.chunk = chunk; this.q = Promise.resolve(); }
  static supported() { return 'bluetooth' in navigator; }
  async connect(acceptAll = false) {
    if (!BleTransport.supported()) throw new Error('This browser has no Web Bluetooth. Use Chrome on Android.');
    const optionalServices = BLE_PROFILES.map(p => p.svc);
    const opts = acceptAll ? { acceptAllDevices: true, optionalServices } : {
      filters: [{ namePrefix: 'SculpFun' }, { namePrefix: 'SCULPFUN' }, { namePrefix: 'sculpfun' }, { namePrefix: 'Sculpfun' }, { services: [BLE_PROFILES[0].svc] }],
      optionalServices,
    };
    this.device = await navigator.bluetooth.requestDevice(opts);
    this.device.addEventListener('gattserverdisconnected', () => { if (this.connected) { this.connected = false; this._close(); } });
    const server = await this.device.gatt.connect();
    let found = null;
    for (const p of BLE_PROFILES) {
      try { const s = await server.getPrimaryService(p.svc); found = { p, s }; break; } catch (e) { }
    }
    if (!found) throw new Error('Engraver serial service not found over BLE. Try "Bluetooth (classic)".');
    this.tx = await found.s.getCharacteristic(found.p.write);
    this.rx = await found.s.getCharacteristic(found.p.notify);
    this.rx.addEventListener('characteristicvaluechanged', (ev) => this._data(new Uint8Array(ev.target.value.buffer.slice(0))));
    await this.rx.startNotifications();
    this.noResp = this.tx.properties.writeWithoutResponse;
    this.connected = true;
  }
  write(d) {
    const bytes = toBytes(d);
    this.q = this.q.then(async () => {
      for (let i = 0; i < bytes.length; i += this.chunk) {
        const part = bytes.slice(i, i + this.chunk);
        if (this.noResp && this.tx.writeValueWithoutResponse) await this.tx.writeValueWithoutResponse(part);
        else await this.tx.writeValueWithResponse(part);
      }
    });
    return this.q;
  }
  async disconnect() { this.connected = false; try { this.device?.gatt?.disconnect(); } catch (e) { } this._close(); }
}

// ---------------- Demo: simulated SculpFun / Grbl_ESP32 machine ----------------
export class DemoTransport extends Base {
  constructor() {
    super(); this.name = 'Demo';
    this.pos = [0, 0]; this.wco = [0, 0]; this.state = 'Idle'; this.laser = 0; this.line = '';
    this.files = {}; this.up = null; this.job = null; this.speedup = 25;
  }
  async connect() {
    this.connected = true;
    this.timer = setInterval(() => this._tick(), 40);
    setTimeout(() => this._send('\r\nGrbl 1.3a [\'$\' for help]\r\n'), 100);
  }
  async disconnect() { clearInterval(this.timer); this.connected = false; this._close(); }
  _send(s) { if (this.connected) this._data(enc.encode(s)); }
  async write(d) {
    const b = toBytes(d);
    await new Promise(r => setTimeout(r, 2 + b.length / 400)); // simulated link speed
    for (let i = 0; i < b.length; i++) this._byte(b[i], b, i);
  }
  _byte(c) {
    if (this.up) return this._upByte(c);
    if (c === 0x3f) return this._status();          // ?
    if (c === 0x21) { if (this.state === 'Run') this.state = 'Hold'; return; } // !
    if (c === 0x7e) { if (this.state === 'Hold') this.state = 'Run'; return; } // ~
    if (c === 0x18) { this.job = null; this.moves = []; this.state = 'Idle'; this.laser = 0; this._send('\r\nGrbl 1.3a [\'$\' for help]\r\n'); return; }
    if (c >= 0x80) return;
    if (c === 0x0a) { const l = this.line.trim(); this.line = ''; this._lineIn(l); return; }
    if (c !== 0x0d) this.line += String.fromCharCode(c);
  }
  _lineIn(l) {
    if (!l) return;
    let m;
    if ((m = l.match(/^\[ESP486\](.*)$/))) { this.up = { name: m[1].trim(), stage: 'hdr', buf: [], len: 0, got: 0, data: [] }; return this._send('ok\r\n'); }
    if ((m = l.match(/^\[ESP220\](.*)$/))) {
      const f = this.files[m[1].trim()];
      if (!f) return this._send('error:60\r\n');
      this.job = { lines: f.split('\n'), i: 0, name: m[1].trim(), budget: 0 };
      this.state = 'Run';
      return this._send('ok\r\n');
    }
    if (l === '$I') return this._send('[VER:1.3a.SculpFun-Demo]\r\n[OPT:VNMHL,35,255]\r\n[MSG:Mechine: SCULPFUN DEMO]\r\nok\r\n');
    if (l === '$X') { this.state = 'Idle'; return this._send('[MSG:Caution: Unlocked]\r\nok\r\n'); }
    if (l === '$H') { this.pos = [0, 0]; return this._send('ok\r\n'); }
    if (this.job) return this._send('error:8\r\n');
    this._exec(l, false);
    this._send('ok\r\n');
  }
  _exec(l, inJob) {
    const u = l.toUpperCase().replace(/\s+/g, '');
    if (/^\$J=/.test(u)) {
      const rel = u.includes('G91');
      const x = u.match(/X(-?[\d.]+)/), y = u.match(/Y(-?[\d.]+)/);
      const t = [...this.pos];
      if (x) t[0] = rel ? t[0] + +x[1] : +x[1] + this.wco[0];
      if (y) t[1] = rel ? t[1] + +y[1] : +y[1] + this.wco[1];
      this.pos = t; this._busy(300); return 0;
    }
    if (u.startsWith('G92.1')) { this.wco = [0, 0]; return 0; }
    if (u.startsWith('G92')) { this.wco = [...this.pos]; return 0; }
    if (/M[34]/.test(u)) { const s = u.match(/S([\d.]+)/); this.laser = s ? +s[1] : this.laser; }
    if (/M0?5/.test(u)) this.laser = 0;
    const x = u.match(/X(-?[\d.]+)/), y = u.match(/Y(-?[\d.]+)/), f = u.match(/F([\d.]+)/);
    if (f) this.feed = +f[1];
    if (x || y) {
      const t = [x ? +x[1] + this.wco[0] : this.pos[0], y ? +y[1] + this.wco[1] : this.pos[1]];
      const dist = Math.hypot(t[0] - this.pos[0], t[1] - this.pos[1]);
      this.pos = t;
      if (!inJob) this._busy(Math.min(1500, dist / ((this.feed || 3000) / 60) * 1000));
      return dist / (/G0/.test(u) ? 6000 : (this.feed || 1000)) * 60000; // ms
    }
    return 0;
  }
  _busy(ms) { if (this.state === 'Idle') { this.state = 'Jog'; clearTimeout(this.bt); this.bt = setTimeout(() => { if (this.state === 'Jog') this.state = 'Idle'; }, ms); } }
  _tick() {
    if (!this.job || this.state !== 'Run') return;
    this.job.budget += 40 * this.speedup;
    while (this.job && this.job.budget > 0) {
      if (this.job.i >= this.job.lines.length) { this.job = null; this.state = 'Idle'; this.laser = 0; return; }
      this.job.budget -= Math.max(0.5, this._exec(this.job.lines[this.job.i++], true));
    }
  }
  _status() {
    const w = [this.pos[0] - this.wco[0], this.pos[1] - this.wco[1]];
    let s = `<${this.state}|WPos:${w[0].toFixed(3)},${w[1].toFixed(3)},0.000|FS:${this.state === 'Run' ? this.feed || 0 : 0},${this.laser}`;
    if (this.job) s += `|SD:${(this.job.i / this.job.lines.length * 100).toFixed(2)},${this.job.name}`;
    this._send(s + '>\r\n');
  }
  _upByte(c) {
    const u = this.up;
    if (u.stage === 'hdr') {
      u.buf.push(c);
      if (u.buf.length === 6) {
        if (u.buf[0] !== 0x0a || u.buf[1] !== 0xa0) { this.up = null; return this._send('error:upload header\r\n'); }
        u.len = (u.buf[2] << 24) | (u.buf[3] << 16) | (u.buf[4] << 8) | u.buf[5];
        u.stage = 'data'; u.chunk = 0; this._send('ok\r\n');
      }
      return;
    }
    if (u.stage === 'data') {
      u.data.push(c); u.got++; u.chunk++;
      if (u.got >= u.len) { u.stage = 'end'; u.buf = []; return this._send('ok\r\n'); }
      if (u.chunk >= 4096) { u.chunk = 0; this._send('ok\r\n'); }
      return;
    }
    if (u.stage === 'end') {
      u.buf.push(c);
      if (u.buf.length === 2) {
        this.files[u.name] = new TextDecoder().decode(new Uint8Array(u.data));
        this.up = null; this._send('ok\r\n');
      }
    }
  }
}
