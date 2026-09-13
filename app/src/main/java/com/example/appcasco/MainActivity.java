package com.example.appcasco;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.graphics.SurfaceTexture;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.text.TextUtils;
import android.util.Log;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.example.appcasco.util.CompatUsbUtils;
import com.example.appcasco.util.CompatIntent; // Importación necesaria para usar la utilidad

import java.util.List;

public class MainActivity extends AppCompatActivity implements TextureView.SurfaceTextureListener {

    private static final String TAG = "MainActivity";
    private static final int NOTIFICATION_PERMISSION_REQUEST_CODE = 1002;
    private static final int CAMERA_MIC_PERMISSION_REQUEST_CODE = 1004;

    // --- UI ---
    private Button transmitButton;
    private Button disconnectButton;
    private TextView statusText;
    private TextureView cameraView;
    private EditText roomNameInput;

    // --- Camera & Service ---
    private UsbDevice detectedCamera = null;
    private boolean isStreaming = false;
    private CameraStreamService cameraService;
    private boolean isServiceBound = false;

    // --- Broadcast Receivers & Connections ---
    private final BroadcastReceiver serviceStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (CameraStreamService.ACTION_SERVICE_STOPPED.equals(intent.getAction())) {
                Log.d(TAG, "Service has stopped, updating UI.");
                isStreaming = false;
                updateUi(false);
                String reason = intent.getStringExtra(CameraStreamService.EXTRA_ERROR_MESSAGE);
                if (TextUtils.isEmpty(reason)) {
                    reason = "Transmisión detenida.";
                }
                Toast.makeText(context, reason, Toast.LENGTH_LONG).show();
            }
        }
    };

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            CameraStreamService.LocalBinder binder = (CameraStreamService.LocalBinder) service;
            cameraService = binder.getService();
            isServiceBound = true;
            Log.d(TAG, "Camera service connected.");
            // Si la vista está lista, se establece la Surface para la previsualización
            if (cameraView.isAvailable()) {
                cameraService.setPreviewSurface(new Surface(cameraView.getSurfaceTexture()));
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            isServiceBound = false;
            cameraService = null;
            Log.d(TAG, "Camera service disconnected.");
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        transmitButton = findViewById(R.id.transmitir_button);
        disconnectButton = findViewById(R.id.desconectar_button);
        statusText = findViewById(R.id.status_text);
        cameraView = findViewById(R.id.camera_view);
        roomNameInput = findViewById(R.id.room_name_input);

        // Soporte Edge-to-Edge para Android 15 y Android 16
        View mainView = findViewById(R.id.main);
        if (mainView != null) {
            ViewCompat.setOnApplyWindowInsetsListener(mainView, (v, insets) -> {
                Insets systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars());
                v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom);
                return insets;
            });
        }

        cameraView.setSurfaceTextureListener(this);
        // Inicialización de permisos y optimizaciones
        ensureNotificationPermission();
        ensureCameraAndMicPermissions();
        checkBatteryOptimizations();

        transmitButton.setOnClickListener(v -> {
            if (detectedCamera == null) {
                Toast.makeText(this, "No USB camera detected", Toast.LENGTH_SHORT).show();
                return;
            }
            String roomName = roomNameInput.getText() != null ? roomNameInput.getText().toString().trim() : "";
            if (TextUtils.isEmpty(roomName)) {
                Toast.makeText(this, "Please enter a room name", Toast.LENGTH_SHORT).show();
                return;
            }
            startCameraService(detectedCamera, roomName);
        });

        disconnectButton.setOnClickListener(v -> stopCameraService());
        updateUi(false);
    }

    @SuppressLint("UnspecifiedRegisterReceiverFlag")
    @Override
    protected void onStart() {
        super.onStart();
        IntentFilter usbFilter = new IntentFilter();
        usbFilter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        usbFilter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(usbDeviceReceiver, usbFilter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(usbDeviceReceiver, usbFilter);
        }

        IntentFilter serviceFilter = new IntentFilter(CameraStreamService.ACTION_SERVICE_STOPPED);
        // Manejo seguro del registro de BroadcastReceiver para API 33+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(serviceStateReceiver, serviceFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(serviceStateReceiver, serviceFilter);
        }

        bindService(new Intent(this, CameraStreamService.class), serviceConnection, Context.BIND_AUTO_CREATE);
        findAlreadyConnectedCamera();
    }

    @Override
    protected void onStop() {
        super.onStop();
        unregisterReceiver(usbDeviceReceiver);
        unregisterReceiver(serviceStateReceiver);
        if (isServiceBound) {
            if (cameraService != null) {
                // Se detiene la Surface Preview para liberar recursos
                cameraService.setPreviewSurface(null);
            }
            unbindService(serviceConnection);
            isServiceBound = false;
        }
    }

    private void startCameraService(UsbDevice device, String roomName) {
        Log.d(TAG, "Sending ACTION_START to service for room: " + roomName);
        isStreaming = true;
        updateUi(true);
        Intent intent = new Intent(this, CameraStreamService.class);
        intent.setAction(CameraStreamService.ACTION_START);
        intent.putExtra(UsbManager.EXTRA_DEVICE, device);
        intent.putExtra(CameraStreamService.EXTRA_ROOM_ID, roomName);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }

    private void stopCameraService() {
        Log.d(TAG, "Sending ACTION_STOP to service");
        startService(new Intent(this, CameraStreamService.class).setAction(CameraStreamService.ACTION_STOP));
    }

    private void findAlreadyConnectedCamera() {
        List<UsbDevice> deviceList = CompatUsbUtils.listDevices(this);
        detectedCamera = null;
        for (UsbDevice device : deviceList) {
            if (CompatUsbUtils.isUvc(device)) {
                detectedCamera = device;
                Toast.makeText(this, "Camera detected. Press 'Transmit'.", Toast.LENGTH_SHORT).show();
                break;
            }
        }
        if (detectedCamera == null && !isStreaming) {
            Toast.makeText(this, "No cameras connected.", Toast.LENGTH_SHORT).show();
        }
    }

    private final BroadcastReceiver usbDeviceReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();

            // CORRECCIÓN: Usar CompatIntent para compatibilidad con Android 13+
            UsbDevice device = CompatIntent.getParcelableExtra(intent, UsbManager.EXTRA_DEVICE, UsbDevice.class);

            if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                if (CompatUsbUtils.isUvc(device)) {
                    detectedCamera = device;
                    Toast.makeText(context, "USB Camera connected.", Toast.LENGTH_LONG).show();
                }
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                if (device != null && device.equals(detectedCamera)) {
                    detectedCamera = null;
                    if (!isStreaming) {
                        Toast.makeText(context, "USB Camera disconnected.", Toast.LENGTH_LONG).show();
                    }
                }
            }
        }
    };

    private void ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST_CODE);
            }
        }
    }

    private void ensureCameraAndMicPermissions() {
        java.util.List<String> permsList = new java.util.ArrayList<>();
        permsList.add(Manifest.permission.CAMERA);
        permsList.add(Manifest.permission.RECORD_AUDIO);
        permsList.add(Manifest.permission.MODIFY_AUDIO_SETTINGS);
        permsList.add(Manifest.permission.ACCESS_FINE_LOCATION);
        permsList.add(Manifest.permission.ACCESS_COARSE_LOCATION);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permsList.add(Manifest.permission.BLUETOOTH_CONNECT);
        }

        java.util.List<String> needed = new java.util.ArrayList<>();
        for (String perm : permsList) {
            if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
                needed.add(perm);
            }
        }

        if (!needed.isEmpty()) {
            ActivityCompat.requestPermissions(this, needed.toArray(new String[0]), CAMERA_MIC_PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == NOTIFICATION_PERMISSION_REQUEST_CODE) {
            if (!(grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED)) {
                Toast.makeText(this, "Notification permission denied.", Toast.LENGTH_LONG).show();
            }
        } else if (requestCode == CAMERA_MIC_PERMISSION_REQUEST_CODE) {
            if (!(grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED)) {
                Toast.makeText(this, "Camera and Microphone permissions are required.", Toast.LENGTH_LONG).show();
            }
        }
    }

    private void checkBatteryOptimizations() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                    android.content.SharedPreferences prefs = getSharedPreferences("appcasco_prefs", MODE_PRIVATE);
                    boolean alreadyPrompted = prefs.getBoolean("battery_prompted", false);
                    if (!alreadyPrompted) {
                        prefs.edit().putBoolean("battery_prompted", true).apply();
                        new androidx.appcompat.app.AlertDialog.Builder(this)
                                .setTitle("Optimización de Batería")
                                .setMessage("Para garantizar que la transmisión del casco continúe sin cortes si la pantalla se apaga o guardas el celular, se sugiere desactivar el ahorro de energía para esta aplicación.")
                                .setPositiveButton("Configurar", (dialog, which) -> {
                                    try {
                                        @SuppressLint("BatteryLife")
                                        Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                                        intent.setData(android.net.Uri.parse("package:" + getPackageName()));
                                        startActivity(intent);
                                    } catch (Exception e) {
                                        try {
                                            Intent fallback = new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                                            startActivity(fallback);
                                        } catch (Exception ignored) {}
                                    }
                                })
                                .setNegativeButton("Continuar", (dialog, which) -> dialog.dismiss())
                                .setCancelable(true)
                                .show();
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Aviso verificando optimización de batería:", e);
            }
        }
    }

    private void updateUi(boolean streaming) {
        isStreaming = streaming;
        statusText.setVisibility(streaming ? View.VISIBLE : View.GONE);
        transmitButton.setEnabled(!streaming);
        disconnectButton.setEnabled(streaming);
        roomNameInput.setEnabled(!streaming);
        cameraView.setVisibility(streaming ? View.VISIBLE : View.INVISIBLE);
    }

    // --- TextureView.SurfaceTextureListener Implementation ---

    @Override public void onSurfaceTextureAvailable(@NonNull SurfaceTexture st, int width, int height) {
        // Enviar la Surface al servicio cuando esté lista
        if (isServiceBound && cameraService != null) {
            cameraService.setPreviewSurface(new Surface(st));
        }
    }

    @Override public void onSurfaceTextureSizeChanged(@NonNull SurfaceTexture st, int width, int height) {}

    @Override public boolean onSurfaceTextureDestroyed(@NonNull SurfaceTexture st) {
        // Quitar la Surface del servicio antes de destruirse
        if (isServiceBound && cameraService != null) {
            cameraService.setPreviewSurface(null);
        }
        return true;
    }

    @Override public void onSurfaceTextureUpdated(@NonNull SurfaceTexture st) {}
}