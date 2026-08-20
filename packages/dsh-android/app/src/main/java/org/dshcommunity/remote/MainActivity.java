package org.dshcommunity.remote;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

public final class MainActivity extends Activity {
  private static final int FILE_CHOOSER_REQUEST = 4107;
  private static final int CAMERA_PERMISSION_REQUEST = 4108;
  private WebView webView;
  private SecureConfig secureConfig;
  private ValueCallback<Uri[]> fileChooserCallback;
  private PermissionRequest cameraPermissionRequest;

  @Override public void onCreate(Bundle state) {
    super.onCreate(state);
    secureConfig = new SecureConfig(this);
    handlePairIntent(getIntent());
    configureFullscreen();
    webView = new WebView(this);
    configureWebView(webView);
    setContentView(webView);
    webView.loadUrl("file:///android_asset/index.html");
  }

  @SuppressWarnings("deprecation")
  @Override public void onBackPressed() {
    if (webView == null) {
      super.onBackPressed();
      return;
    }
    webView.evaluateJavascript(
        "Boolean(window.DshRemoteBack && window.DshRemoteBack())",
        handled -> {
          if (!"true".equals(handled)) MainActivity.super.onBackPressed();
        });
  }

  @Override protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    handlePairIntent(intent);
    if (webView != null) webView.reload();
  }

  @Override public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) configureFullscreen();
  }

  @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == FILE_CHOOSER_REQUEST) {
      ValueCallback<Uri[]> callback = fileChooserCallback;
      fileChooserCallback = null;
      if (callback != null) callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  @Override public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    if (requestCode == CAMERA_PERMISSION_REQUEST) {
      PermissionRequest request = cameraPermissionRequest;
      cameraPermissionRequest = null;
      if (request != null) {
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
          request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
        } else {
          request.deny();
        }
      }
      return;
    }
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
  }

  private void configureFullscreen() {
    getWindow().getDecorView().setSystemUiVisibility(
        View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            | View.SYSTEM_UI_FLAG_FULLSCREEN
            | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
  }

  @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
  private void configureWebView(WebView view) {
    WebSettings settings = view.getSettings();
    settings.setJavaScriptEnabled(true);
    // UI preferences use DOM storage; relay credentials remain Keystore-backed.
    settings.setDomStorageEnabled(true);
    settings.setDatabaseEnabled(false);
    settings.setAllowContentAccess(false);
    settings.setAllowFileAccess(true);
    settings.setAllowFileAccessFromFileURLs(false);
    settings.setAllowUniversalAccessFromFileURLs(false);
    settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
    view.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
    view.addJavascriptInterface(new NativeBridge(), "DshRemoteNative");
    view.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(PermissionRequest request) {
        runOnUiThread(() -> {
          String[] resources = request.getResources();
          boolean videoOnly = resources.length == 1 && PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[0]);
          if (!videoOnly || webView == null || !"file:///android_asset/index.html".equals(webView.getUrl())) {
            request.deny();
            return;
          }
          if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] { PermissionRequest.RESOURCE_VIDEO_CAPTURE });
            return;
          }
          if (cameraPermissionRequest != null) cameraPermissionRequest.deny();
          cameraPermissionRequest = request;
          requestPermissions(new String[] { Manifest.permission.CAMERA }, CAMERA_PERMISSION_REQUEST);
        });
      }

      @Override public void onPermissionRequestCanceled(PermissionRequest request) {
        if (cameraPermissionRequest == request) cameraPermissionRequest = null;
      }

      @Override public boolean onShowFileChooser(
          WebView ignored,
          ValueCallback<Uri[]> callback,
          FileChooserParams parameters) {
        if (fileChooserCallback != null) fileChooserCallback.onReceiveValue(null);
        fileChooserCallback = callback;
        Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        picker.addCategory(Intent.CATEGORY_OPENABLE);
        picker.setType("image/*");
        picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
        try {
          startActivityForResult(picker, FILE_CHOOSER_REQUEST);
          return true;
        } catch (Exception error) {
          fileChooserCallback = null;
          callback.onReceiveValue(null);
          return false;
        }
      }
    });
    view.setWebViewClient(new WebViewClient() {
      @Override public boolean shouldOverrideUrlLoading(WebView ignored, WebResourceRequest request) {
        Uri target = request.getUrl();
        return !("file".equals(target.getScheme())
            && (target.getAuthority() == null || target.getAuthority().isEmpty())
            && "/android_asset/index.html".equals(target.getPath()));
      }
    });
  }

  private void handlePairIntent(Intent intent) {
    Uri uri = intent == null ? null : intent.getData();
    if (uri != null && acceptPairingUri(uri, false)) intent.setData(null);
  }

  private boolean acceptPairingUri(Uri uri, boolean allowRetarget) {
    String trustedAppLinkHost = trustedAppLinkHost();
    boolean customPair = trustedAppLinkHost == null
        && "dshremote".equals(uri.getScheme())
        && "pair".equals(uri.getHost());
    boolean verifiedPair = "https".equals(uri.getScheme())
        && trustedAppLinkHost != null
        && trustedAppLinkHost.equalsIgnoreCase(uri.getHost())
        && "/dsh-remote/pair".equals(uri.getPath());
    // Debug builds have no verified App Link host. An explicit in-app scan may
    // still consume the desktop plugin's same-domain HTTPS QR, while external
    // intents remain restricted to the release App Link contract.
    boolean scannedHttpsPair = allowRetarget
        && trustedAppLinkHost == null
        && "https".equals(uri.getScheme())
        && "/dsh-remote/pair".equals(uri.getPath());
    if (!customPair && !verifiedPair && !scannedHttpsPair) return false;
    try {
      String relay = uri.getQueryParameter("relay");
      String host = uri.getQueryParameter("host");
      String token = uri.getQueryParameter("token");
      if (relay == null || host == null || token == null
          || !host.matches("^[A-Za-z0-9._-]{3,128}$")
          || !token.matches("^[A-Za-z0-9_-]{43,128}$")) return false;
      Uri relayUri = Uri.parse(relay);
      boolean secureRelay = "https".equals(relayUri.getScheme());
      boolean loopbackDebugRelay = trustedAppLinkHost == null
          && "http".equals(relayUri.getScheme())
          && ("127.0.0.1".equals(relayUri.getHost()) || "localhost".equalsIgnoreCase(relayUri.getHost()));
      if ((!secureRelay && !loopbackDebugRelay)
          || relayUri.getHost() == null
          || relayUri.getUserInfo() != null
          || relayUri.getFragment() != null) return false;
      if ((verifiedPair || scannedHttpsPair)
          && (uri.getUserInfo() != null
              || uri.getFragment() != null
              || !relayUri.getHost().equalsIgnoreCase(uri.getHost()))) return false;
      JSONObject existing = new JSONObject(secureConfig.load());
      String existingRelay = existing.optString("relay", "");
      String existingHost = existing.optString("hostId", "");
      // A QR may rotate the credential for the same deployment, but an
      // arbitrary browser/app deep link must never silently retarget an
      // already configured phone to a different relay or host.
      if (!allowRetarget && ((!existingRelay.isEmpty() && !existingRelay.equals(relay))
          || (!existingHost.isEmpty() && !existingHost.equals(host)))) return false;
      JSONObject config = new JSONObject();
      config.put("relay", relay);
      config.put("hostId", host);
      config.put("token", token);
      secureConfig.save(config.toString());
      return true;
    } catch (Exception ignored) {
      return false;
    }
  }

  private String trustedAppLinkHost() {
    try {
      ApplicationInfo info = getPackageManager().getApplicationInfo(getPackageName(), PackageManager.GET_META_DATA);
      return info.metaData == null ? null : info.metaData.getString("org.dshcommunity.remote.APP_LINK_HOST");
    } catch (Exception ignored) {
      return null;
    }
  }

  private final class NativeBridge {
    @JavascriptInterface public String loadConfig() { return secureConfig.load(); }
    @JavascriptInterface public boolean saveConfig(String json) {
      try { secureConfig.save(json); return true; }
      catch (Exception ignored) { return false; }
    }
    @JavascriptInterface public void clearConfig() { secureConfig.clear(); }
    @JavascriptInterface public boolean acceptPairingUri(String value) {
      try { return MainActivity.this.acceptPairingUri(Uri.parse(value), true); }
      catch (Exception ignored) { return false; }
    }
    @JavascriptInterface public boolean copyText(String text) {
      try {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) return false;
        clipboard.setPrimaryClip(ClipData.newPlainText("DSH Remote Companion", text == null ? "" : text));
        return true;
      } catch (Exception ignored) { return false; }
    }
    @JavascriptInterface public String deviceId() {
      return Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
    }
  }

  private static final class SecureConfig {
    private static final String PREFS = "remote_config";
    private static final String KEY_ALIAS = "dsh-remote-companion-v1";
    private static final String VALUE = "encrypted";
    private final SharedPreferences preferences;

    SecureConfig(Activity activity) { preferences = activity.getSharedPreferences(PREFS, MODE_PRIVATE); }

    String load() {
      String stored = preferences.getString(VALUE, "");
      if (stored.isEmpty()) return "{}";
      try {
        byte[] packed = Base64.getDecoder().decode(stored);
        byte[] iv = new byte[12];
        System.arraycopy(packed, 0, iv, 0, iv.length);
        byte[] body = new byte[packed.length - iv.length];
        System.arraycopy(packed, iv.length, body, 0, body.length);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(body), StandardCharsets.UTF_8);
      } catch (Exception error) {
        clear();
        return "{}";
      }
    }

    void save(String json) throws Exception {
      JSONObject value = new JSONObject(json);
      String relay = value.optString("relay", "");
      String host = value.optString("hostId", "");
      String token = value.optString("token", "");
      Uri relayUri = Uri.parse(relay);
      String relayScheme = relayUri.getScheme();
      String relayHost = relayUri.getHost();
      boolean secureRelay = "https".equals(relayScheme) && relayHost != null;
      boolean loopbackRelay = "http".equals(relayScheme)
          && ("127.0.0.1".equals(relayHost) || "localhost".equals(relayHost) || "::1".equals(relayHost));
      if ((!secureRelay && !loopbackRelay) || relayUri.getUserInfo() != null)
        throw new IllegalArgumentException("relay must use HTTPS");
      if (host.length() < 3 || token.length() < 24) throw new IllegalArgumentException("invalid config");
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key());
      byte[] body = cipher.doFinal(json.getBytes(StandardCharsets.UTF_8));
      byte[] iv = cipher.getIV();
      byte[] packed = new byte[iv.length + body.length];
      System.arraycopy(iv, 0, packed, 0, iv.length);
      System.arraycopy(body, 0, packed, iv.length, body.length);
      preferences.edit().putString(VALUE, Base64.getEncoder().encodeToString(packed)).apply();
    }

    void clear() { preferences.edit().clear().apply(); }

    private SecretKey key() throws Exception {
      KeyStore store = KeyStore.getInstance("AndroidKeyStore");
      store.load(null);
      if (!store.containsAlias(KEY_ALIAS)) {
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build());
        generator.generateKey();
      }
      return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
    }
  }
}
