package com.example.appcasco;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Binder;
import android.os.IBinder;
import android.os.PowerManager;
import android.text.TextUtils;
import android.util.Log;
import android.view.Surface;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.example.appcasco.signaling.FirestoreSignaling;
import com.example.appcasco.util.CompatIntent;
import com.example.appcasco.webrtc.FrameConverter;
import com.example.appcasco.webrtc.WebRtcClient;
import com.google.firebase.auth.FirebaseAuth;
import com.serenegiant.usb.IFrameCallback;
import com.serenegiant.usb.USBMonitor;
import com.serenegiant.usb.UVCCamera;

import org.webrtc.IceCandidate;
import org.webrtc.PeerConnection;
import org.webrtc.SessionDescription;

import java.nio.ByteBuffer;

// CLASE: Asegúrate de que todos los métodos estén dentro de este bloque
public class CameraStreamService extends Service implements WebRtcClient.Events, FirestoreSignaling.Listener {

    public static final String ACTION_START = "com.example.app.ACTION_START";
    public static final String ACTION_STOP  = "com.example.app.ACTION_STOP";
    public static final String ACTION_SERVICE_STOPPED = "com.example.app.ACTION_SERVICE_STOPPED";
    public static final String EXTRA_ROOM_ID = "com.example.app.EXTRA_ROOM_ID";

    private static final String TAG = "CameraStreamService";
    private static final String NOTIFICATION_CHANNEL_ID = "CameraServiceChannel";
    private static final int NOTIFICATION_ID = 1;
    private static final int PREVIEW_WIDTH = 640;
    private static final int PREVIEW_HEIGHT = 480;

    private USBMonitor usbMonitor;
    private UVCCamera uvcCamera;
    private boolean isPreviewRunning = false;
    private Surface previewSurface;

    private FirebaseAuth mAuth;
    private WebRtcClient webRtcClient;
    private FirestoreSignaling firestoreSignaling;
    private String roomId;

    private ByteBuffer i420_y, i420_u, i420_v;
    private PowerManager.WakeLock wakeLock;

    public class LocalBinder extends Binder {
        public CameraStreamService getService() { return CameraStreamService.this; }
    }
    private final IBinder binder = new LocalBinder();

    @Nullable @Override public IBinder onBind(Intent intent) { return binder; }

    public void setPreviewSurface(Surface surface) {
        this.previewSurface = surface;
        if (uvcCamera != null && isPreviewRunning) {
            if (previewSurface != null && previewSurface.isValid()) {
                uvcCamera.setPreviewDisplay(previewSurface);
            } else {
                uvcCamera.stopPreview();
                isPreviewRunning = false;
            }
        }
    }

    private final IFrameCallback frameCallback = frame -> {
        if (frame == null || webRtcClient == null) return;
        long timestampNs = System.nanoTime();
        if (i420_y == null) {
            i420_y = ByteBuffer.allocateDirect(PREVIEW_WIDTH * PREVIEW_HEIGHT);
            i420_u = ByteBuffer.allocateDirect(PREVIEW_WIDTH * PREVIEW_HEIGHT / 4);
            i420_v = ByteBuffer.allocateDirect(PREVIEW_WIDTH * PREVIEW_HEIGHT / 4);
        }
        FrameConverter.nv21ToI420(frame, PREVIEW_WIDTH, PREVIEW_HEIGHT, i420_y, i420_u, i420_v);
        webRtcClient.pushI420Frame(i420_y, i420_u, i420_v, PREVIEW_WIDTH, PREVIEW_HEIGHT, 0, timestampNs);
    };

    private final USBMonitor.OnDeviceConnectListener onDeviceConnectListener = new USBMonitor.OnDeviceConnectListener() {
        @Override public void onAttach(UsbDevice d) {}
        @Override public void onDettach(UsbDevice d) { handleStopAction(); }
        @Override public void onConnect(UsbDevice d, USBMonitor.UsbControlBlock cb, boolean createNew) { openCamera(cb); }
        @Override public void onDisconnect(UsbDevice d, USBMonitor.UsbControlBlock cb) { handleStopAction(); }
        @Override public void onCancel(UsbDevice d) {}
    };


    @Override public void onCreate() {
        super.onCreate();
        mAuth = FirebaseAuth.getInstance();
        createNotificationChannel();
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
                handleStopAction();
                return START_NOT_STICKY;
            }
            startForeground(NOTIFICATION_ID, createNotification("Transmitting to room: " + roomId));
            final UsbDevice device = CompatIntent.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice.class);
            if (device != null) usbMonitor.requestPermission(device);
            else {
                Log.e(TAG, "USB Device not found in intent.");
                handleStopAction();
            }

        } else if (ACTION_STOP.equals(action)) {
            handleStopAction();
        }
        return START_NOT_STICKY;
    }

    private void openCamera(USBMonitor.UsbControlBlock ctrlBlock) {
        if (uvcCamera != null) uvcCamera.destroy();
        uvcCamera = new UVCCamera();
        try {
            uvcCamera.open(ctrlBlock);
            uvcCamera.setPreviewSize(PREVIEW_WIDTH, PREVIEW_HEIGHT, UVCCamera.DEFAULT_PREVIEW_MODE);
        } catch (Exception e) {
            Log.e(TAG, "Failed to open UVC Camera.", e);
            handleStopAction();
            return;
        }
        if (previewSurface != null) uvcCamera.setPreviewDisplay(previewSurface);
        uvcCamera.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21);
        uvcCamera.startPreview();
        isPreviewRunning = true;
        ensureAuthAndStartRtc();
    }

    private void ensureAuthAndStartRtc() {
        if (mAuth.getCurrentUser() != null) {
            clearRoomAndStartSignaling();
        } else {
            mAuth.signInAnonymously().addOnCompleteListener(authTask -> {
                if (authTask.isSuccessful()) {
                    Log.d(TAG, "Firebase authenticated anonymously.");
                    clearRoomAndStartSignaling();
                } else {
                    Log.e(TAG, "Firebase auth failed.", authTask.getException());
                    handleStopAction();
                }
            });
        }
    }

    private void clearRoomAndStartSignaling() {
        if (roomId == null) return;
        firestoreSignaling = new FirestoreSignaling(this, roomId, this);

        firestoreSignaling.clearRoom().addOnCompleteListener(clearTask -> {
            if (!clearTask.isSuccessful()) {
                Log.w(TAG, "Failed to clear room, attempting to proceed.", clearTask.getException());
            }
            Log.d(TAG, "Room state established. Starting WebRTC negotiation.");

            webRtcClient = new WebRtcClient(this, this);
            firestoreSignaling.listenForAnswer();
            firestoreSignaling.listenForRemoteIce("callee");
            webRtcClient.createOffer();
        });
    }

    private void stopCamera() {
        if (uvcCamera != null) {
            try { uvcCamera.stopPreview(); } catch (Exception ignored) {}
            isPreviewRunning = false;
            try { uvcCamera.destroy(); } catch (Exception ignored) {}
            uvcCamera = null;
        }
    }

    private void stopRtc() {
        if (webRtcClient != null) {
            webRtcClient.close();
            webRtcClient = null;
        }
        if (firestoreSignaling != null) {
            firestoreSignaling.dispose();
            firestoreSignaling.clearRoom();
            firestoreSignaling = null;
        }
        roomId = null;
    }

    // CORRECCIÓN: Este método estaba causando errores si no estaba bien declarado
    private void handleStopAction() {
        releaseWakeLock();
        stopRtc();
        stopCamera();
        stopForeground(true);
        sendBroadcast(new Intent(ACTION_SERVICE_STOPPED));
        stopSelf();
    }

    @Override public void onDestroy() {
        // CORRECCIÓN: onDestroy debe llamar a handleStopAction si el servicio se destruye
        handleStopAction();
        if (usbMonitor != null) usbMonitor.destroy();
        super.onDestroy();
    }

    // CORRECCIÓN: Este método estaba causando errores si no estaba bien declarado
    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager powerManager = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "appcasco::TransmissionWakelock");
        }
        if (!wakeLock.isHeld()) {
            wakeLock.acquire(10*60*1000L /*10 minutes*/);
            Log.d(TAG, "WakeLock acquired");
        }
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
            Log.d(TAG, "WakeLock released");
        }
    }

    // --- Implementación de WebRtcClient.Events ---

    @Override public void onLocalSdp(SessionDescription sdp) {
        if (firestoreSignaling != null) firestoreSignaling.postLocalSdp(sdp);
    }

    @Override public void onLocalIce(IceCandidate cand) {
        if (firestoreSignaling != null) firestoreSignaling.postIce(cand, "caller");
    }

    @Override public void onRemoteSdp(SessionDescription sdp) {
        if (webRtcClient != null) {
            webRtcClient.setRemoteDescription(sdp);
            if (sdp.type == SessionDescription.Type.ANSWER && firestoreSignaling != null) {
                firestoreSignaling.updateRoomStatus("active");
            }
        }
    }

    @Override public void onRemoteIce(IceCandidate c) {
        if (webRtcClient != null) webRtcClient.addRemoteIce(c);
    }

    @Override public void onIceConnectionStateChange(PeerConnection.IceConnectionState newState) {
        Log.d(TAG, "ICE connection state changed to: " + newState.name());
        if (newState == PeerConnection.IceConnectionState.CONNECTED || newState == PeerConnection.IceConnectionState.COMPLETED) {
            Log.d(TAG, "¡CONEXIÓN EXITOSA!");
            updateNotification();
        } else if (newState == PeerConnection.IceConnectionState.FAILED) {
            Log.e(TAG, "ICE Connection Failed. Attempting restart...");
        }
    }

    // --- Implementación de FirestoreSignaling.Listener ---

    @Override public void onError(String message, Exception e) {
        Log.e(TAG, "Signaling error: " + message, e);
    }

    // --- Funciones de Notificación ---

    // CORRECCIÓN: Este método estaba causando errores si no estaba bien declarado
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    NOTIFICATION_CHANNEL_ID, "Active Camera", NotificationManager.IMPORTANCE_LOW);
            getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    private void updateNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, createNotification("Streaming connection active."));
    }

    private Notification createNotification(String text) {
        return new NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
                .setContentTitle("External Camera Active")
                .setContentText(text)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setOngoing(true)
                .build();
    }
}