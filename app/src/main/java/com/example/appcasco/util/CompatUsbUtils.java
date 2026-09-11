package com.example.appcasco.util;

import android.content.Context;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;

import com.serenegiant.usb.USBMonitor;

import java.util.ArrayList;
import java.util.List;

public final class CompatUsbUtils {
  private CompatUsbUtils() {}

  /** Lista todos los dispositivos USB conectados. */
  public static List<UsbDevice> listDevices(Context ctx) {
    UsbManager um = (UsbManager) ctx.getSystemService(Context.USB_SERVICE);
    return new ArrayList<>(um.getDeviceList().values());
  }

  /** ¿Es cámara UVC? (clase de Video 0x0E a nivel de device o interface) */
  public static boolean isUvc(UsbDevice d) {
    if (d == null) return false;
    if (d.getDeviceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
    for (int i = 0; i < d.getInterfaceCount(); i++) {
      if (d.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
    }
    return false;
  }

  /** Pide permiso usando USBMonitor (recomendado con UVCCamera). */
  public static void requestPermission(USBMonitor monitor, UsbDevice d) {
    if (monitor != null && d != null) monitor.requestPermission(d);
  }

  /** Descripción corta para logs/UI. */
  public static String describe(UsbDevice d) {
    if (d == null) return "(null)";
    return "USB devName=" + d.getDeviceName()
        + " VID=" + d.getVendorId()
        + " PID=" + d.getProductId();
  }
}
