package com.example.appcasco;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Binder;
import android.os.IBinder;
import android.os.PowerManager;
import android.net.wifi.WifiManager;
import android.text.TextUtils;
import android.util.Log;
import android.view.Surface;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.example.appcasco.livekit.LiveKitStreamManager;
import com.example.appcasco.util.CompatIntent;
import com.example.appcasco.util.LocationTracker;
import com.example.appcasco.webrtc.FrameConverter;
import com.serenegiant.usb.IFrameCallback;
import com.serenegiant.usb.USBMonitor;
import com.serenegiant.usb.UVCCamera;

import java.nio.ByteBuffer;


/**
 * Foreground Service para captura de cámara externa USB (UVC)
 * y transmisión en tiempo real hacia LiveKit Cloud (SFU).
 */
public class CameraStreamService extends Service implements LiveKitStreamManager.Events {

    public static final String ACTION_START = "com.example.app.ACTION_START";
    public static final String ACTION_STOP  = "com.example.app.ACTION_STOP";
    public static final String ACTION_SERVICE_STOPPED = "com.example.app.ACTION_SERVICE_STOPPED";
    public static final String EXTRA_ROOM_ID = "com.example.app.EXTRA_ROOM_ID";
    public static final String EXTRA_ERROR_MESSAGE = "com.example.app.EXTRA_ERROR_MESSAGE";

    private static final String TAG = "CameraStreamService";
    private static final String NOTIFICATION_CHANNEL_ID = "CameraServiceChannel";
    private static final int NOTIFICATION_ID = 1;
    private static final int PREVIEW_WIDTH = 640;
    private static final int PREVIEW_HEIGHT = 480;

    private USBMonitor usbMonitor;
    private UVCCamera uvcCamera;
    private boolean isPreviewRunning = false;
    private Surface previewSurface;

    private LiveKitStreamManager liveKitManager;
    private LocationTracker locationTracker;
    private String roomId;

    private ByteBuffer i420_y, i420_u, i420_v;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public class LocalBinder extends Binder {
        public CameraStreamService getService() { return CameraStreamService.this; }
    }
    private final IBinder binder = new LocalBinder();

    @Nullable @Override public IBinder onBind(Intent intent) { return binder; }

    public void setPreviewSurface(Surface surface) {
        this.previewSurface = surface;
        if (uvcCamera != null && isPreviewRunning) {
            try {
                if (previewSurface != null && previewSurface.isValid()) {
                    uvcCamera.setPreviewDisplay(previewSurface);
                } else {
                    // Desvincular la Surface visual sin detener la captura continua del sensor ni el envío a LiveKit
                    uvcCamera.setPreviewDisplay((Surface) null);
                }
            } catch (Exception e) {
                Log.w(TAG, "Aviso ajustando PreviewDisplay de UVC:", e);
            }
        }
    }

    private final IFrameCallback frameCallback = frame -> {
        if (frame == null || liveKitManager == null) return;
        long timestampNs = System.nanoTime();
        if (i420_y == null) {
            i420_y = ByteBuffer.allocateDirect(PREVIEW_WIDTH * PREVIEW_HEIGHT);
            i420_u = ByteBuffer.allocateDirect(PREVIEW_WIDTH * PREVIEW_HEIGHT / 4);
            i420_v = ByteBuffer.allocateDirect(PREVIEW_WIDTH * PREVIEW_HEIGHT / 4);
        }
        FrameConverter.nv21ToI420(frame, PREVIEW_WIDTH, PREVIEW_HEIGHT, i420_y, i420_u, i420_v);
        liveKitManager.pushI420Frame(i420_y, i420_u, i420_v, PREVIEW_WIDTH, PREVIEW_HEIGHT, 0, timestampNs);
    };

    private final USBMonitor.OnDeviceConnectListener onDeviceConnectListener = new USBMonitor.OnDeviceConnectListener() {
        @Override public void onAttach(UsbDevice d) {}
        @Override public void onDettach(UsbDevice d) { handleStopAction("Cámara USB desconectada"); }
        @Override public void onConnect(UsbDevice d, USBMonitor.UsbControlBlock cb, boolean createNew) { openCamera(cb); }
        @Override public void onDisconnect(UsbDevice d, USBMonitor.UsbControlBlock cb) { handleStopAction("Conexión USB interrumpida"); }
        @Override public void onCancel(UsbDevice d) {}
    };

    @Override public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        liveKitManager = new LiveKitStreamManager(this, this);
        usbMonitor = new USBMonitor(this, onDeviceConnectListener);
        usbMonitor.register();
    }

    @Override public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        final String action = intent.getAction();

        if (ACTION_START.equals(action)) {
            acquireWakeLock();
            this.roomId = intent.getStringExtra(EXTRA_ROOM_ID);
            if (TextUtils.isEmpty(roomId)) {
                Log.e(TAG, "Room ID is missing.");
                handleStopAction("Nombre de sala no especificado");
                return START_NOT_STICKY;
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                int serviceType = 0;
                // Dispositivo USB conectado para la cámara del casco
                serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE;

                if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.CAMERA) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
                }
                if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.RECORD_AUDIO) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
                    }
                }
                if (androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_FINE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED
                        || androidx.core.content.ContextCompat.checkSelfPermission(this, android.Manifest.permission.ACCESS_COARSE_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    serviceType |= android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
                }

                startForeground(NOTIFICATION_ID, createNotification("Transmitiendo en sala: " + roomId), serviceType);
            } else {
                startForeground(NOTIFICATION_ID, createNotification("Transmitiendo en sala: " + roomId));
            }

            // Iniciar seguimiento continuo de ubicación GPS
            if (locationTracker != null) locationTracker.stop();
            locationTracker = new LocationTracker(this, location -> {
                if (liveKitManager != null) {
                    liveKitManager.sendLocation(location);
                }
            });
            locationTracker.start();
            final UsbDevice device = CompatIntent.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice.class);
            if (device != null) {
                usbMonitor.requestPermission(device);
            } else {
                Log.e(TAG, "USB Device not found in intent.");
                handleStopAction("Dispositivo USB no encontrado");
            }

        } else if (ACTION_STOP.equals(action)) {
            handleStopAction("Transmisión detenida por el usuario");
        }
        // START_STICKY asegura que si el sistema mata el servicio por presión de memoria, intente recrearlo
        return START_STICKY;
    }

    private void openCamera(USBMonitor.UsbControlBlock ctrlBlock) {
        if (uvcCamera != null) uvcCamera.destroy();
        uvcCamera = new UVCCamera();
        try {
            uvcCamera.open(ctrlBlock);
            // Intenta modo YUYV predeterminado; si falla, intenta con MJPEG
            try {
                uvcCamera.setPreviewSize(PREVIEW_WIDTH, PREVIEW_HEIGHT, UVCCamera.DEFAULT_PREVIEW_MODE);
            } catch (Exception eYuyv) {
                Log.w(TAG, "YUYV no soportado por la cámara, intentando MJPEG...", eYuyv);
                uvcCamera.setPreviewSize(PREVIEW_WIDTH, PREVIEW_HEIGHT, UVCCamera.FRAME_FORMAT_MJPEG);
            }
        } catch (Exception e) {
            Log.e(TAG, "Fallo al abrir cámara UVC.", e);
            handleStopAction("Fallo al inicializar cámara UVC: " + e.getMessage());
            return;
        }

        if (previewSurface != null && previewSurface.isValid()) {
            uvcCamera.setPreviewDisplay(previewSurface);
        }
        uvcCamera.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21);
        uvcCamera.startPreview();
        isPreviewRunning = true;

        // Iniciar streaming hacia LiveKit Cloud
        startLiveKit();
    }

    private void startLiveKit() {
        if (roomId == null) return;
        Log.d(TAG, "Conectando a LiveKit Cloud para la sala: " + roomId);
        if (liveKitManager != null) {
            liveKitManager.startStream(roomId);
        }
    }


    private void stopCamera() {
        if (uvcCamera != null) {
            try { uvcCamera.stopPreview(); } catch (Exception ignored) {}
            isPreviewRunning = false;
            try { uvcCamera.destroy(); } catch (Exception ignored) {}
            uvcCamera = null;
        }
    }

    private void stopLiveKit() {
        if (liveKitManager != null) {
            liveKitManager.stopStream();
        }
        roomId = null;
    }

    private void handleStopAction(String reason) {
        Log.d(TAG, "Deteniendo servicio de streaming. Razón: " + reason);
        releaseWakeLock();
        if (locationTracker != null) {
            locationTracker.stop();
            locationTracker = null;
        }
        stopLiveKit();
        stopCamera();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }

        Intent stoppedIntent = new Intent(ACTION_SERVICE_STOPPED);
        stoppedIntent.putExtra(EXTRA_ERROR_MESSAGE, reason);
        sendBroadcast(stoppedIntent);
        stopSelf();
    }

    @Override public void onDestroy() {
        handleStopAction("Servicio destruido");
        if (usbMonitor != null) usbMonitor.destroy();
        super.onDestroy();
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (powerManager != null) {
                    wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "appcasco::TransmissionWakelock");
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(); // Mantiene la CPU despierta para streaming continuo
                Log.d(TAG, "WakeLock adquirido");
            }
        } catch (Exception e) {
            Log.w(TAG, "Error adquiriendo WakeLock:", e);
        }

        try {
            if (wifiLock == null) {
                WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifiManager != null) {
                    wifiLock = wifiManager.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "appcasco::TransmissionWifiLock");
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire(); // Evita suspensión o limitación de Wi-Fi con pantalla bloqueada
                Log.d(TAG, "WifiLock adquirido");
            }
        } catch (Exception e) {
            Log.w(TAG, "Error adquiriendo WifiLock:", e);
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
                Log.d(TAG, "WakeLock liberado");
            }
        } catch (Exception e) {
            Log.w(TAG, "Error liberando WakeLock:", e);
        }

        try {
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
                Log.d(TAG, "WifiLock liberado");
            }
        } catch (Exception e) {
            Log.w(TAG, "Error liberando WifiLock:", e);
        }
    }

    // --- Implementación de LiveKitStreamManager.Events ---

    @Override public void onConnected() {
        Log.d(TAG, "LiveKit: Conectado al servidor SFU");
        updateNotification("Conectado al servidor LiveKit");
    }

    @Override public void onStreamingStarted() {
        Log.d(TAG, "LiveKit: Video en vivo publicándose exitosamente");
        updateNotification("Transmitiendo video en vivo a LiveKit");
    }

    @Override public void onDisconnected() {
        Log.d(TAG, "LiveKit: Desconectado");
    }

    @Override public void onError(String message) {
        Log.e(TAG, "Error LiveKit: " + message);
        updateNotification("Error LiveKit: " + message);
    }

    // --- Notificaciones ---

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    NOTIFICATION_CHANNEL_ID,
                    "Llamada y Transmisión del Casco",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Mantiene la transmisión de video, audio bidireccional y GPS activa en segundo plano");
            channel.setShowBadge(true);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void updateNotification(String text) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, createNotification(text));
        }
    }

    private Notification createNotification(String text) {
        // Intent para volver a MainActivity al tocar la notificación
        Intent launchIntent = new Intent(this, MainActivity.class);
        launchIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent contentPendingIntent = PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Acción rápida para colgar/detener la transmisión desde la barra de notificaciones
        Intent stopIntent = new Intent(this, CameraStreamService.class);
        stopIntent.setAction(ACTION_STOP);
        PendingIntent stopPendingIntent = PendingIntent.getService(
                this,
                1,
                stopIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
                .setContentTitle("Casco Inteligente — Transmisión Activa")
                .setContentText(text)
                .setSubText(roomId != null ? "Sala: " + roomId : null)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentIntent(contentPendingIntent)
                .addAction(android.R.drawable.ic_menu_close_clear_cancel, "🛑 Detener", stopPendingIntent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_CALL)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setShowWhen(true)
                .setUsesChronometer(true)
                .build();
    }
}