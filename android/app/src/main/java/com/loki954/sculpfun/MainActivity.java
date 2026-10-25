package com.loki954.sculpfun;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String HOST = "sculpfun.app";
    private static final String START = "https://" + HOST + "/index.html";
    private static final int REQ_FILE = 11, REQ_SAVE = 12, REQ_PERM = 13;

    private WebView web;
    private BtBridge bt;
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingSave;
    private SharedPreferences prefs;
    private String pendingApkUrl;
    private long lastCheck = 0;
    private long apkDownloadId = -1;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable periodicCheck = new Runnable() {
        @Override public void run() { checkForUpdates(false); handler.postDelayed(this, 30 * 60 * 1000L); }
    };

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("app", MODE_PRIVATE);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#14161a"));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(true);

        bt = new BtBridge(this);
        web.addJavascriptInterface(bt, "AndroidBT");
        web.addJavascriptInterface(new AppBridge(), "AndroidApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) {
                    String path = u.getPath() == null ? "/" : u.getPath();
                    if (path.equals("/") || path.equals("/index.html")) {
                        WebResourceResponse r = new WebResourceResponse("text/html", "utf-8", new ByteArrayInputStream(loadHtml()));
                        java.util.Map<String, String> h = new java.util.HashMap<>();
                        h.put("Cache-Control", "no-store");
                        r.setResponseHeaders(h);
                        return r;
                    }
                    return new WebResourceResponse("text/plain", "utf-8", 404, "Not found", new java.util.HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (HOST.equals(u.getHost())) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i;
                try { i = params.createIntent(); } catch (Exception e) { i = new Intent(Intent.ACTION_GET_CONTENT); i.setType("*/*"); }
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String[] types = params.getAcceptTypes();
                boolean wantsImage = false;
                if (types != null) for (String t : types) if (t != null && t.contains("image")) wantsImage = true;
                if (wantsImage) {
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "image/svg+xml"});
                } else {
                    i.setType("*/*");
                }
                try { startActivityForResult(Intent.createChooser(i, "Choose file"), REQ_FILE); }
                catch (Exception e) { fileCallback = null; return false; }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                android.util.Log.d("SculpFunWeb", m.message() + " @" + m.lineNumber());
                return true;
            }
        });

        web.loadUrl(START);
        requestBtPermissions();
        handler.postDelayed(periodicCheck, 3000);
    }

    // ---------- web app content (bundled, or a newer downloaded version) ----------
    private int bundledWebVersion() {
        try (InputStream in = getAssets().open("web-version.txt")) {
            return Integer.parseInt(new String(readAll(in), StandardCharsets.UTF_8).trim());
        } catch (Exception e) { return 0; }
    }

    private byte[] loadHtml() {
        try {
            File f = new File(getFilesDir(), "app.html");
            int dl = prefs.getInt("webVersion", 0);
            if (f.exists() && dl > bundledWebVersion()) {
                try (InputStream in = new FileInputStream(f)) { return readAll(in); }
            }
            try (InputStream in = getAssets().open("app.html")) { return readAll(in); }
        } catch (Exception e) {
            return ("<h1>Could not load app</h1><pre>" + e + "</pre>").getBytes(StandardCharsets.UTF_8);
        }
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] b = new byte[65536];
        int n;
        while ((n = in.read(b)) > 0) bo.write(b, 0, n);
        return bo.toByteArray();
    }

    // ---------- updates from GitHub releases ----------
    private void checkForUpdates(final boolean manual) {
        lastCheck = System.currentTimeMillis();
        new Thread(() -> {
            try {
                String json = new String(httpGet(BuildConfig.UPDATE_URL), StandardCharsets.UTF_8);
                JSONObject j = new JSONObject(json);
                int webV = j.optInt("web", 0);
                int nativeV = j.optInt("native", 0);
                String version = j.optString("version", "");
                int current = Math.max(prefs.getInt("webVersion", 0), bundledWebVersion());
                boolean changed = false;
                if (webV > current && j.has("html")) {
                    byte[] html = httpGet(j.getString("html"));
                    if (html.length > 10000) {
                        File tmp = new File(getFilesDir(), "app.html.tmp");
                        try (OutputStream o = new FileOutputStream(tmp)) { o.write(html); }
                        File dst = new File(getFilesDir(), "app.html");
                        if (dst.exists()) dst.delete();
                        if (tmp.renameTo(dst)) { prefs.edit().putInt("webVersion", webV).apply(); changed = true; }
                    }
                }
                if (nativeV > BuildConfig.NATIVE_VERSION && j.has("apk")) {
                    pendingApkUrl = j.getString("apk");
                    sendToJs("window.__appEvent && window.__appEvent({type:'apkUpdate', version:" + JSONObject.quote(version) + "})");
                } else if (changed) {
                    sendToJs("window.__appEvent && window.__appEvent({type:'updateReady', version:" + JSONObject.quote(version) + "})");
                } else if (manual) {
                    sendToJs("window.__appEvent && window.__appEvent({type:'upToDate'})");
                }
            } catch (Exception e) {
                if (manual) sendToJs("window.__appEvent && window.__appEvent({type:'updateError', message:" + JSONObject.quote(String.valueOf(e.getMessage())) + "})");
            }
        }, "updater").start();
    }

    private static byte[] httpGet(String url) throws Exception {
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(60000);
            c.setRequestProperty("User-Agent", "SculpFunStudio-Android");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400) { url = new URL(new URL(url), c.getHeaderField("Location")).toString(); c.disconnect(); continue; }
            if (code != 200) throw new Exception("HTTP " + code);
            try (InputStream in = c.getInputStream()) { return readAll(in); }
        }
        throw new Exception("Too many redirects");
    }

    // ---------- helpers used by the bridges ----------
    public void sendToJs(final String js) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    public void setKeepScreenOn(final boolean on) {
        runOnUiThread(() -> {
            if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        });
    }

    public void requestBtPermissions() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.BLUETOOTH_CONNECT);
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) need.add(Manifest.permission.BLUETOOTH_SCAN);
        }
        // Like the original SculpFun app: location permission is needed to find Bluetooth devices on many phones
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.ACCESS_FINE_LOCATION);
            need.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (!need.isEmpty()) requestPermissions(need.toArray(new String[0]), REQ_PERM);
    }

    public boolean isLocationEnabled() {
        try {
            android.location.LocationManager lm = (android.location.LocationManager) getSystemService(Context.LOCATION_SERVICE);
            if (Build.VERSION.SDK_INT >= 28) return lm.isLocationEnabled();
            return lm.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER);
        } catch (Exception e) { return true; }
    }

    public void openLocationSettings() {
        runOnUiThread(() -> { try { startActivity(new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)); } catch (Exception ignored) { } });
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] res) {
        super.onRequestPermissionsResult(code, perms, res);
        sendToJs("window.__bt && window.__bt({type:'perm'})");
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE) {
            Uri[] result = null;
            if (res == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    result = new Uri[n];
                    for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) result = new Uri[]{data.getData()};
            }
            if (fileCallback != null) fileCallback.onReceiveValue(result);
            fileCallback = null;
        } else if (req == REQ_SAVE) {
            if (res == RESULT_OK && data != null && data.getData() != null && pendingSave != null) {
                try (OutputStream o = getContentResolver().openOutputStream(data.getData())) {
                    o.write(pendingSave);
                    Toast.makeText(this, "Saved", Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(this, "Save failed: " + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
            pendingSave = null;
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.__back && window.__back()) ? 'y' : 'n'", v -> {
            if (v == null || !v.contains("y")) finishAndRemoveTask();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (lastCheck > 0 && System.currentTimeMillis() - lastCheck > 10 * 60 * 1000L) checkForUpdates(false);
        sendToJs("window.__appEvent && window.__appEvent({type:'resume'})");
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(periodicCheck);
        if (apkReceiver != null) { try { unregisterReceiver(apkReceiver); } catch (Exception ignored) { } }
        if (bt != null) bt.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    // ---------- download the new APK and open the Android installer ----------
    private BroadcastReceiver apkReceiver;

    private void downloadAndInstall(String url) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(this, "Allow Loki Laser to install updates, then tap Download again", Toast.LENGTH_LONG).show();
            try { startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))); } catch (Exception ignored) { }
            return;
        }
        try {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            File old = new File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "Loki-Laser-update.apk");
            if (old.exists()) old.delete();
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            r.setTitle("Loki Laser update");
            r.setMimeType("application/vnd.android.package-archive");
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, "Loki-Laser-update.apk");
            if (apkReceiver == null) {
                apkReceiver = new BroadcastReceiver() {
                    @Override public void onReceive(Context c, Intent i) {
                        long id = i.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                        if (id != apkDownloadId) return;
                        Uri apk = dm.getUriForDownloadedFile(id);
                        if (apk == null) { Toast.makeText(MainActivity.this, "Update download failed", Toast.LENGTH_LONG).show(); return; }
                        Intent inst = new Intent(Intent.ACTION_VIEW);
                        inst.setDataAndType(apk, "application/vnd.android.package-archive");
                        inst.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                        try { startActivity(inst); } catch (Exception e) { Toast.makeText(MainActivity.this, "Open the downloaded update from notifications", Toast.LENGTH_LONG).show(); }
                    }
                };
                IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
                if (Build.VERSION.SDK_INT >= 33) registerReceiver(apkReceiver, f, Context.RECEIVER_EXPORTED);
                else registerReceiver(apkReceiver, f);
            }
            apkDownloadId = dm.enqueue(r);
            Toast.makeText(this, "Downloading update…", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
        }
    }

    /** General app functions exposed as window.AndroidApp */
    public class AppBridge {
        @JavascriptInterface
        public String info() {
            try {
                JSONObject o = new JSONObject();
                o.put("version", BuildConfig.VERSION_NAME);
                o.put("native", BuildConfig.NATIVE_VERSION);
                o.put("web", Math.max(prefs.getInt("webVersion", 0), bundledWebVersion()));
                return o.toString();
            } catch (Exception e) { return "{}"; }
        }

        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String b64) {
            pendingSave = Base64.decode(b64, Base64.DEFAULT);
            runOnUiThread(() -> {
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); }
                catch (Exception e) { Toast.makeText(MainActivity.this, "Cannot save: " + e.getMessage(), Toast.LENGTH_LONG).show(); }
            });
        }

        @JavascriptInterface
        public void reload() { runOnUiThread(() -> web.loadUrl(START)); }

        @JavascriptInterface
        public void checkUpdate() { checkForUpdates(true); }

        @JavascriptInterface
        public void installUpdate() {
            final String u = pendingApkUrl;
            if (u == null) return;
            runOnUiThread(() -> downloadAndInstall(u));
        }

        @JavascriptInterface
        public void openUrl(final String u) {
            runOnUiThread(() -> { try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u))); } catch (Exception ignored) { } });
        }

        @JavascriptInterface
        public void keepScreenOn(boolean on) { setKeepScreenOn(on); }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(() -> {
                if (bt != null) bt.shutdown();
                finishAndRemoveTask();
            });
        }

        @JavascriptInterface
        public void toast(final String msg) { runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show()); }
    }
}
