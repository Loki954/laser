package com.loki954.sculpfun;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Bluetooth Classic (SPP / RFCOMM) bridge exposed to the web UI as window.AndroidBT */
@SuppressLint("MissingPermission")
public class BtBridge {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805f9b34fb");
    private final MainActivity act;
    private final BluetoothAdapter adapter;
    private volatile BluetoothSocket socket;
    private volatile OutputStream out;
    private volatile boolean connected = false;
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private BroadcastReceiver scanReceiver;

    public BtBridge(MainActivity act) {
        this.act = act;
        BluetoothManager bm = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
        adapter = bm != null ? bm.getAdapter() : null;
    }

    private boolean hasPerm() {
        if (Build.VERSION.SDK_INT >= 31) {
            return act.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private void emit(JSONObject o) { act.sendToJs("window.__bt && window.__bt(" + o.toString() + ")"); }

    private void emit(String type, String key, Object val) {
        try {
            JSONObject o = new JSONObject();
            o.put("type", type);
            if (key != null) o.put(key, val);
            emit(o);
        } catch (Exception ignored) { }
    }

    @JavascriptInterface
    public String state() {
        if (adapter == null) return "unsupported";
        if (!hasPerm()) return "noperm";
        if (!adapter.isEnabled()) return "off";
        return connected ? "connected" : "ready";
    }

    @JavascriptInterface
    public void requestSetup() {
        act.runOnUiThread(() -> {
            if (!hasPerm()) { act.requestBtPermissions(); return; }
            if (adapter != null && !adapter.isEnabled()) {
                try { act.startActivity(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)); } catch (Exception ignored) { }
            }
        });
    }

    @JavascriptInterface
    public String devices() {
        JSONArray arr = new JSONArray();
        try {
            if (adapter == null || !hasPerm()) return arr.toString();
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded != null) for (BluetoothDevice d : bonded) {
                JSONObject o = new JSONObject();
                o.put("name", d.getName() == null ? d.getAddress() : d.getName());
                o.put("address", d.getAddress());
                o.put("paired", true);
                arr.put(o);
            }
        } catch (Exception e) { emit("log", "text", "devices: " + e); }
        return arr.toString();
    }

    @JavascriptInterface
    public void startScan() {
        act.runOnUiThread(() -> {
            if (adapter == null) return;
            if (!hasPerm() || (Build.VERSION.SDK_INT >= 31 && act.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED)) {
                act.requestBtPermissions(); emit("scanDone", null, null); return;
            }
            stopScanInternal();
            scanReceiver = new BroadcastReceiver() {
                @Override public void onReceive(Context c, Intent i) {
                    String a = i.getAction();
                    if (BluetoothDevice.ACTION_FOUND.equals(a)) {
                        BluetoothDevice d = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                        if (d == null) return;
                        try {
                            JSONObject o = new JSONObject();
                            o.put("type", "found");
                            o.put("name", d.getName() == null ? "" : d.getName());
                            o.put("address", d.getAddress());
                            emit(o);
                        } catch (Exception ignored) { }
                    } else if (BluetoothAdapter.ACTION_DISCOVERY_FINISHED.equals(a)) {
                        emit("scanDone", null, null);
                    }
                }
            };
            IntentFilter f = new IntentFilter();
            f.addAction(BluetoothDevice.ACTION_FOUND);
            f.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
            if (Build.VERSION.SDK_INT >= 33) act.registerReceiver(scanReceiver, f, Context.RECEIVER_EXPORTED);
            else act.registerReceiver(scanReceiver, f);
            try { adapter.startDiscovery(); } catch (Exception e) { emit("scanDone", null, null); }
        });
    }

    @JavascriptInterface
    public void stopScan() { act.runOnUiThread(this::stopScanInternal); }

    private void stopScanInternal() {
        try { if (adapter != null) adapter.cancelDiscovery(); } catch (Exception ignored) { }
        if (scanReceiver != null) { try { act.unregisterReceiver(scanReceiver); } catch (Exception ignored) { } scanReceiver = null; }
    }

    @JavascriptInterface
    public void connect(final String address) {
        new Thread(() -> {
            try {
                if (adapter == null) throw new Exception("This device has no Bluetooth");
                if (!hasPerm()) { act.runOnUiThread(act::requestBtPermissions); throw new Exception("Allow Bluetooth permission and try again"); }
                if (!adapter.isEnabled()) throw new Exception("Turn on Bluetooth and try again");
                try { adapter.cancelDiscovery(); } catch (Exception ignored) { }
                closeInternal(false);
                BluetoothDevice dev = adapter.getRemoteDevice(address);
                BluetoothSocket s = null;
                Exception last = null;
                for (int attempt = 0; attempt < 3 && s == null; attempt++) {
                    BluetoothSocket t = null;
                    try {
                        if (attempt == 0) t = dev.createRfcommSocketToServiceRecord(SPP);
                        else if (attempt == 1) t = dev.createInsecureRfcommSocketToServiceRecord(SPP);
                        else {
                            Method m = dev.getClass().getMethod("createRfcommSocket", int.class);
                            t = (BluetoothSocket) m.invoke(dev, 1);
                        }
                        t.connect();
                        s = t;
                    } catch (Exception e) {
                        last = e;
                        try { if (t != null) t.close(); } catch (Exception ignored) { }
                    }
                }
                if (s == null) throw new Exception("Could not connect: " + (last != null ? last.getMessage() : "unknown"));
                socket = s;
                out = s.getOutputStream();
                connected = true;
                act.setKeepScreenOn(true);
                emit("open", "name", dev.getName() == null ? address : dev.getName());
                final InputStream in = s.getInputStream();
                final BluetoothSocket mine = s;
                new Thread(() -> readLoop(in, mine), "bt-read").start();
            } catch (Exception e) {
                emit("error", "message", e.getMessage() == null ? e.toString() : e.getMessage());
            }
        }, "bt-connect").start();
    }

    private void readLoop(InputStream in, BluetoothSocket mine) {
        byte[] buf = new byte[4096];
        try {
            while (connected && socket == mine) {
                int n = in.read(buf);
                if (n < 0) break;
                if (n > 0) emit("data", "b64", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
            }
        } catch (Exception ignored) { }
        if (socket == mine) closeInternal(true);
    }

    @JavascriptInterface
    public void write(final int id, final String b64) {
        final byte[] data = Base64.decode(b64, Base64.DEFAULT);
        writer.execute(() -> {
            try {
                OutputStream o = out;
                if (o == null || !connected) throw new Exception("Not connected");
                o.write(data);
                o.flush();
                emit("written", "id", id);
            } catch (Exception e) {
                try {
                    JSONObject j = new JSONObject();
                    j.put("type", "writeError"); j.put("id", id); j.put("message", String.valueOf(e.getMessage()));
                    emit(j);
                } catch (Exception ignored) { }
            }
        });
    }

    @JavascriptInterface
    public void close() { new Thread(() -> closeInternal(true)).start(); }

    private synchronized void closeInternal(boolean notify) {
        boolean was = connected || socket != null;
        connected = false;
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
        socket = null; out = null;
        act.setKeepScreenOn(false);
        if (notify && was) emit("closed", null, null);
    }

    public void shutdown() { stopScanInternal(); closeInternal(false); writer.shutdownNow(); }
}
