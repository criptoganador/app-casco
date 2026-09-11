package com.example.appcasco.util;

import android.content.Intent;
import android.os.Build;
import android.os.Parcelable;

public final class CompatIntent {
  private CompatIntent() {}

  public static <T extends Parcelable> T getParcelableExtra(Intent intent, String key, Class<T> cls) {
    if (intent == null) return null;
    if (Build.VERSION.SDK_INT >= 33) {
      return intent.getParcelableExtra(key, cls);
    } else {
      @SuppressWarnings("deprecation")
      T val = intent.getParcelableExtra(key);
      return val;
    }
  }
}
