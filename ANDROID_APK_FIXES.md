# Android APK fixes

This build now generates the native Android launcher icon from the Study Board artwork and declares CAMERA permission for WebView getUserMedia(). Capacitor's Android BridgeWebChromeClient handles the WebView camera permission request and runtime Android permission dialog.
