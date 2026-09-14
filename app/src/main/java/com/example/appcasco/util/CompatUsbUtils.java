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

  /** ¿Es cámara UVC? (clase de Video 0x0E a nivel de device o interface, o descriptor MISC/IAD) */
  public static boolean isUvc(UsbDevice d) {
    if (d == null) return false;
    if (d.getDeviceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
    for (int i = 0; i < d.getInterfaceCount(); i++) {
      if (d.getInterface(i).getInterfaceClass() == UsbConstants.USB_CLASS_VIDEO) return true;
    }
    // Compatibilidad con descriptores IAD en Android 13/14 (Redmi/HyperOS)
    if (d.getDeviceClass() == UsbConstants.USB_CLASS_MISC || d.getDeviceClass() == UsbConstants.USB_CLASS_PER_INTERFACE) {
      if (d.getInterfaceCount() > 0) {
        int ifClass = d.getInterface(0).getInterfaceClass();
        if (ifClass != UsbConstants.USB_CLASS_MASS_STORAGE && ifClass != UsbConstants.USB_CLASS_HUB) {
          return true;
        }
      }
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
