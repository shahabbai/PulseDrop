# THIS FILE IS AUTO-GENERATED. DO NOT MODIFY!!

# Copyright 2020-2023 Tauri Programme within The Commons Conservancy
# SPDX-License-Identifier: Apache-2.0
# SPDX-License-Identifier: MIT

-keep class com.pulsedrop.transfer.* {
  native <methods>;
}

-keep class com.pulsedrop.transfer.WryActivity {
  public <init>(...);

  void setWebView(com.pulsedrop.transfer.RustWebView);
  java.lang.Class getAppClass(...);
  int getId();
  java.lang.String getVersion();
  int startActivity(...);
}

-keep class com.pulsedrop.transfer.Ipc {
  public <init>(...);

  @android.webkit.JavascriptInterface public <methods>;
}

-keep class com.pulsedrop.transfer.RustWebView {
  public <init>(...);

  void loadUrlMainThread(...);
  void loadHTMLMainThread(...);
  void evalScript(...);
}

-keep class com.pulsedrop.transfer.RustWebChromeClient,com.pulsedrop.transfer.RustWebViewClient {
  public <init>(...);
}
