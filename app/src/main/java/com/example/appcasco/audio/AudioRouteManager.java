package com.example.appcasco.audio;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothHeadset;
import android.bluetooth.BluetoothProfile;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import java.util.List;

/**
 * Gestor profesional de enrutamiento de audio y manejo de desconexiones
 * para cascos inteligentes y dispositivos móviles (Android 7.0 a Android 15+).
 *
 * Características:
 * 1. Detección en tiempo real de conexión/desconexión (AudioDeviceCallback + ACTION_AUDIO_BECOMING_NOISY).
 * 2. Protección contra fallos (Null-safety riguroso y try-catch defensivo en todas las APIs del sistema).
 * 3. Estrategia de respaldo (Fallback) automático: Bluetooth -> Auriculares con cable/USB -> Altavoz integrado.
 * 4. Temporizador de respaldo (Watchdog timeout de 8 segundos) en conexiones Bluetooth para evitar audio mudo.
 * 5. Gestión limpia del Foco de Audio (AudioFocus) y restauración de AudioManager.MODE_NORMAL al finalizar.
 */
public class AudioRouteManager {

    private static final String TAG = "AudioRouteManager";
    private static final long BLUETOOTH_TIMEOUT_MS = 8000; // 8 segundos de timeout

    public interface AudioRouteListener {
        void onRouteChanged(String routeName, @Nullable AudioDeviceInfo deviceInfo);
        void onDeviceDisconnected(String deviceName, String fallbackRouteName);
    }

    private final Context context;
    private final AudioManager audioManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private AudioRouteListener listener;

    private boolean isCallActive = false;
    private AudioFocusRequest focusRequest = null;
    private boolean isReceiverRegistered = false;
    private boolean isDeviceCallbackRegistered = false;

    // Timeout watchdog para conexiones Bluetooth
    private final Runnable bluetoothTimeoutRunnable = this::onBluetoothTimeout;

    // Callback de hardware (Android 6.0+ / API 23+)
    private final AudioDeviceCallback audioDeviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] addedDevices) {
            if (!isCallActive || addedDevices == null) return;
            Log.d(TAG, "🎧 Dispositivo de audio conectado (onAudioDevicesAdded)");
            for (AudioDeviceInfo dev : addedDevices) {
                if (dev != null) {
                    Log.d(TAG, "   -> Agregado: " + getDeviceTypeName(dev.getType()) + " [" + dev.getProductName() + "]");
                }
            }
            evaluateAndAutoRoute(false);
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removedDevices) {
            if (!isCallActive || removedDevices == null) return;
            Log.w(TAG, "⚠️ Dispositivo de audio desconectado (onAudioDevicesRemoved)");
            String disconnectedName = "Desconocido";
            for (AudioDeviceInfo dev : removedDevices) {
                if (dev != null) {
                    disconnectedName = dev.getProductName() != null ? dev.getProductName().toString() : getDeviceTypeName(dev.getType());
                    Log.w(TAG, "   -> Desconectado bruscamente: " + disconnectedName);
                }
            }
            handleDeviceDisconnection(disconnectedName);
        }
    };

    // BroadcastReceiver para eventos críticos del sistema (desconexión repentina de cables/bluetooth)
    private final BroadcastReceiver audioBroadcastReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            if (intent == null || !isCallActive) return;
            String action = intent.getAction();
            if (action == null) return;

            switch (action) {
                case AudioManager.ACTION_AUDIO_BECOMING_NOISY:
                    // Se desconectaron los auriculares físicos o se apagó el Bluetooth mientras se reproduce audio
                    Log.w(TAG, "⚠️ ACTION_AUDIO_BECOMING_NOISY recibido: Auriculares o Bluetooth desconectados.");
                    handleDeviceDisconnection("Auricular/Bluetooth desconectado");
                    break;

                case BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED:
                    int state = intent.getIntExtra(BluetoothProfile.EXTRA_STATE, BluetoothProfile.STATE_DISCONNECTED);
                    if (state == BluetoothProfile.STATE_DISCONNECTED) {
                        Log.w(TAG, "⚠️ BluetoothHeadset STATE_DISCONNECTED");
                        handleDeviceDisconnection("Bluetooth Manos Libres");
                    } else if (state == BluetoothProfile.STATE_CONNECTED) {
                        Log.d(TAG, "✅ BluetoothHeadset STATE_CONNECTED -> Reenrutando");
                        evaluateAndAutoRoute(false);
                    }
                    break;

                case AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED:
                    int scoState = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_DISCONNECTED);
                    Log.d(TAG, "SCO audio state: " + scoState);
                    if (scoState == AudioManager.SCO_AUDIO_STATE_CONNECTED) {
                        cancelBluetoothTimeout();
                        Log.d(TAG, "✅ Canal de audio Bluetooth SCO enlazado correctamente");
                    } else if (scoState == AudioManager.SCO_AUDIO_STATE_DISCONNECTED) {
                        Log.w(TAG, "⚠️ Canal Bluetooth SCO desconectado");
                    }
                    break;
            }
        }
    };

    public AudioRouteManager(@NonNull Context context) {
        this.context = context.getApplicationContext();
        this.audioManager = (AudioManager) this.context.getSystemService(Context.AUDIO_SERVICE);
    }

    public void setListener(AudioRouteListener listener) {
        this.listener = listener;
    }

    /**
     * Inicia el modo de llamada dúplex, solicita el Foco de Audio y registra los detectores.
     */
    public void startCallAudio() {
        if (audioManager == null) {
            Log.e(TAG, "AudioManager no disponible");
            return;
        }

        try {
            isCallActive = true;
            Log.d(TAG, "Iniciando modo de comunicación de audio...");

            // 1. Activar modo de comunicación para habilitar cancelación acústica de eco (AEC) y filtros
            audioManager.setMode(AudioManager.MODE_IN_COMMUNICATION);

            // 2. Solicitar foco de audio prioritario para llamadas de voz
            requestAudioFocus();

            // 3. Registrar AudioDeviceCallback
            registerDeviceCallback();

            // 4. Registrar BroadcastReceiver de desconexiones
            registerReceivers();

            // 5. Evaluar y seleccionar la mejor ruta disponible
            evaluateAndAutoRoute(true);

        } catch (Exception e) {
            Log.e(TAG, "Error iniciando audio de llamada:", e);
            fallbackToSpeakerphone("Error en startCallAudio");
        }
    }

    /**
     * Libera todos los recursos de audio, restaura el modo normal y desregistra callbacks.
     */
    public void stopCallAudio() {
        Log.d(TAG, "Deteniendo modo de llamada y restaurando estado de audio...");
        isCallActive = false;
        cancelBluetoothTimeout();

        if (audioManager != null) {
            try {
                // Limpiar dispositivo de comunicación en Android 12+
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    audioManager.clearCommunicationDevice();
                }

                // Detener Bluetooth SCO en versiones anteriores
                try {
                    audioManager.stopBluetoothSco();
                    audioManager.setBluetoothScoOn(false);
                } catch (Exception ignored) {}

                try {
                    audioManager.setSpeakerphoneOn(false);
                } catch (Exception ignored) {}

                // Abandonar foco de audio
                abandonAudioFocus();

                // Restaurar modo normal
                audioManager.setMode(AudioManager.MODE_NORMAL);

            } catch (Exception e) {
                Log.w(TAG, "Aviso limpiando AudioManager:", e);
            }
        }

        unregisterDeviceCallback();
        unregisterReceivers();
    }

    /**
     * Evalúa los dispositivos disponibles y enruta con prioridad:
     * 1. Bluetooth Headset (BLE / SCO / A2DP)
     * 2. Auriculares con cable / USB
     * 3. Altavoz integrado (Fallback para casco)
     */
    public void evaluateAndAutoRoute(boolean isInitial) {
        if (!isCallActive || audioManager == null) return;

        mainHandler.post(() -> {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    routeModernAndroid();
                } else {
                    routeLegacyAndroid();
                }
            } catch (Exception e) {
                Log.e(TAG, "Error en evaluateAndAutoRoute:", e);
                fallbackToSpeakerphone("Excepción evaluando ruta");
            }
        });
    }

    /**
     * Enrutamiento moderno para Android 12+ (API 31+) usando setCommunicationDevice.
     */
    private void routeModernAndroid() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || audioManager == null) return;

        try {
            List<AudioDeviceInfo> availableDevices = audioManager.getAvailableCommunicationDevices();
            if (availableDevices == null || availableDevices.isEmpty()) {
                Log.w(TAG, "No hay dispositivos de comunicación disponibles, fallback a altavoz");
                fallbackToSpeakerphone("Sin dispositivos disponibles");
                return;
            }

            AudioDeviceInfo bluetoothDevice = null;
            AudioDeviceInfo wiredHeadset = null;
            AudioDeviceInfo speakerDevice = null;

            for (AudioDeviceInfo device : availableDevices) {
                if (device == null) continue;
                int type = device.getType();
                if (type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
                    type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
                    type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) {
                    bluetoothDevice = device;
                } else if (type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                           type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                           type == AudioDeviceInfo.TYPE_USB_HEADSET ||
                           type == AudioDeviceInfo.TYPE_USB_DEVICE) {
                    wiredHeadset = device;
                } else if (type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                    speakerDevice = device;
                }
            }

            // Prioridad 1: Bluetooth Headset
            if (bluetoothDevice != null) {
                Log.d(TAG, "Enrutando audio hacia Bluetooth: " + bluetoothDevice.getProductName());
                startBluetoothTimeoutWatchdog();
                boolean ok = audioManager.setCommunicationDevice(bluetoothDevice);
                if (ok) {
                    notifyRouteChanged("Bluetooth: " + bluetoothDevice.getProductName(), bluetoothDevice);
                    return;
                } else {
                    Log.w(TAG, "Fallo al asignar dispositivo Bluetooth, intentando siguiente ruta");
                }
            }

            // Prioridad 2: Auriculares con cable o USB
            cancelBluetoothTimeout();
            if (wiredHeadset != null) {
                Log.d(TAG, "Enrutando audio hacia Auricular Cable/USB: " + wiredHeadset.getProductName());
                boolean ok = audioManager.setCommunicationDevice(wiredHeadset);
                if (ok) {
                    notifyRouteChanged("Auricular: " + wiredHeadset.getProductName(), wiredHeadset);
                    return;
                }
            }

            // Prioridad 3 (Fallback definitivo): Altavoz integrado
            if (speakerDevice != null) {
                Log.d(TAG, "Enrutando audio hacia Altavoz Integrado (Fallback)");
                audioManager.setCommunicationDevice(speakerDevice);
                notifyRouteChanged("Altavoz Integrado", speakerDevice);
            } else {
                audioManager.clearCommunicationDevice();
                audioManager.setSpeakerphoneOn(true);
                notifyRouteChanged("Altavoz (Speakerphone)", null);
            }

        } catch (Exception e) {
            Log.e(TAG, "Error en routeModernAndroid:", e);
            fallbackToSpeakerphone("Fallo en API 31+");
        }
    }

    /**
     * Enrutamiento para Android 7.0 a 11 (API 24-30).
     */
    @SuppressWarnings("deprecation")
    private void routeLegacyAndroid() {
        if (audioManager == null) return;

        try {
            boolean hasBluetooth = isBluetoothConnectedLegacy();
            boolean hasWired = audioManager.isWiredHeadsetOn();

            if (hasBluetooth) {
                Log.d(TAG, "[Legacy] Conectando canal Bluetooth SCO...");
                startBluetoothTimeoutWatchdog();
                audioManager.setSpeakerphoneOn(false);
                audioManager.startBluetoothSco();
                audioManager.setBluetoothScoOn(true);
                notifyRouteChanged("Bluetooth SCO", null);
                return;
            }

            cancelBluetoothTimeout();
            try {
                audioManager.stopBluetoothSco();
                audioManager.setBluetoothScoOn(false);
            } catch (Exception ignored) {}

            if (hasWired) {
                Log.d(TAG, "[Legacy] Conectando Auricular Cable...");
                audioManager.setSpeakerphoneOn(false);
                notifyRouteChanged("Auricular con cable", null);
                return;
            }

            // Fallback a altavoz
            Log.d(TAG, "[Legacy] Activando Altavoz integrado...");
            audioManager.setSpeakerphoneOn(true);
            adjustSpeakerVolume();
            notifyRouteChanged("Altavoz Integrado", null);

        } catch (Exception e) {
            Log.e(TAG, "Error en routeLegacyAndroid:", e);
            fallbackToSpeakerphone("Fallo legacy");
        }
    }

    /**
     * Manejo inmediato ante desconexión imprevista de periféricos.
     */
    private void handleDeviceDisconnection(String deviceName) {
        cancelBluetoothTimeout();
        mainHandler.post(() -> {
            try {
                Log.w(TAG, "🚨 Activando protocolo de Fallback tras desconexión de: " + deviceName);

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && audioManager != null) {
                    audioManager.clearCommunicationDevice();
                }

                // Evaluar la siguiente mejor ruta disponible
                evaluateAndAutoRoute(false);

                if (listener != null) {
                    listener.onDeviceDisconnected(deviceName, getCurrentRouteName());
                }
            } catch (Exception e) {
                Log.e(TAG, "Error en handleDeviceDisconnection:", e);
                fallbackToSpeakerphone(deviceName);
            }
        });
    }

    /**
     * Fallback forzado a altavoz para asegurar que el operador nunca quede incomunicado.
     */
    private void fallbackToSpeakerphone(String reason) {
        try {
            Log.w(TAG, "🔊 Activando Altavoz por Fallback seguro. Motivo: " + reason);
            if (audioManager != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    List<AudioDeviceInfo> available = audioManager.getAvailableCommunicationDevices();
                    AudioDeviceInfo speaker = null;
                    if (available != null) {
                        for (AudioDeviceInfo d : available) {
                            if (d != null && d.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                                speaker = d;
                                break;
                            }
                        }
                    }
                    if (speaker != null) {
                        audioManager.setCommunicationDevice(speaker);
                    } else {
                        audioManager.clearCommunicationDevice();
                        audioManager.setSpeakerphoneOn(true);
                    }
                } else {
                    audioManager.stopBluetoothSco();
                    audioManager.setBluetoothScoOn(false);
                    audioManager.setSpeakerphoneOn(true);
                }
                adjustSpeakerVolume();
            }
            notifyRouteChanged("Altavoz (Fallback)", null);
        } catch (Exception e) {
            Log.e(TAG, "Error crítico en fallbackToSpeakerphone:", e);
        }
    }

    private void adjustSpeakerVolume() {
        if (audioManager == null) return;
        try {
            int maxVol = audioManager.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL);
            int curVol = audioManager.getStreamVolume(AudioManager.STREAM_VOICE_CALL);
            if (curVol < (int) (maxVol * 0.6)) {
                audioManager.setStreamVolume(AudioManager.STREAM_VOICE_CALL, (int) (maxVol * 0.70), 0);
            }
        } catch (Exception ignored) {}
    }

    private void startBluetoothTimeoutWatchdog() {
        cancelBluetoothTimeout();
        mainHandler.postDelayed(bluetoothTimeoutRunnable, BLUETOOTH_TIMEOUT_MS);
    }

    private void cancelBluetoothTimeout() {
        mainHandler.removeCallbacks(bluetoothTimeoutRunnable);
    }

    private void onBluetoothTimeout() {
        if (!isCallActive) return;
        Log.w(TAG, "⏱ Timeout de conexión Bluetooth (" + (BLUETOOTH_TIMEOUT_MS / 1000) + "s alcanzado sin enlace). Ejecutando fallback a altavoz.");
        fallbackToSpeakerphone("Timeout de conexión Bluetooth");
    }

    private void requestAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes playbackAttributes = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build();

                focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
                        .setAudioAttributes(playbackAttributes)
                        .setAcceptsDelayedFocusGain(true)
                        .setOnAudioFocusChangeListener(focusChange -> {
                            Log.d(TAG, "AudioFocus change: " + focusChange);
                        })
                        .build();

                audioManager.requestAudioFocus(focusRequest);
            } else {
                audioManager.requestAudioFocus(
                        null,
                        AudioManager.STREAM_VOICE_CALL,
                        AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
                );
            }
            Log.d(TAG, "Foco de audio de llamada solicitado exitosamente");
        } catch (Exception e) {
            Log.w(TAG, "Aviso solicitando foco de audio:", e);
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focusRequest != null) {
                audioManager.abandonAudioFocusRequest(focusRequest);
                focusRequest = null;
            } else {
                audioManager.abandonAudioFocus(null);
            }
        } catch (Exception ignored) {}
    }

    private void registerDeviceCallback() {
        if (audioManager == null || isDeviceCallbackRegistered) return;
        try {
            audioManager.registerAudioDeviceCallback(audioDeviceCallback, mainHandler);
            isDeviceCallbackRegistered = true;
            Log.d(TAG, "AudioDeviceCallback registrado");
        } catch (Exception e) {
            Log.w(TAG, "Aviso registrando AudioDeviceCallback:", e);
        }
    }

    private void unregisterDeviceCallback() {
        if (audioManager == null || !isDeviceCallbackRegistered) return;
        try {
            audioManager.unregisterAudioDeviceCallback(audioDeviceCallback);
            isDeviceCallbackRegistered = false;
        } catch (Exception ignored) {}
    }

    private void registerReceivers() {
        if (isReceiverRegistered) return;
        try {
            IntentFilter filter = new IntentFilter();
            filter.addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
            filter.addAction(BluetoothHeadset.ACTION_CONNECTION_STATE_CHANGED);
            filter.addAction(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED);
            filter.addAction(Intent.ACTION_HEADSET_PLUG);

            context.registerReceiver(audioBroadcastReceiver, filter);
            isReceiverRegistered = true;
            Log.d(TAG, "BroadcastReceiver de audio registrado");
        } catch (Exception e) {
            Log.w(TAG, "Aviso registrando BroadcastReceiver de audio:", e);
        }
    }

    private void unregisterReceivers() {
        if (!isReceiverRegistered) return;
        try {
            context.unregisterReceiver(audioBroadcastReceiver);
            isReceiverRegistered = false;
        } catch (Exception ignored) {}
    }

    private boolean isBluetoothConnectedLegacy() {
        if (audioManager != null) {
            if (audioManager.isBluetoothA2dpOn() || audioManager.isBluetoothScoOn()) return true;
        }
        try {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter != null && adapter.isEnabled()) {
                int profileState = adapter.getProfileConnectionState(BluetoothProfile.HEADSET);
                return profileState == BluetoothProfile.STATE_CONNECTED;
            }
        } catch (Exception ignored) {}
        return false;
    }

    private void notifyRouteChanged(String routeName, @Nullable AudioDeviceInfo deviceInfo) {
        if (listener != null) {
            listener.onRouteChanged(routeName, deviceInfo);
        }
    }

    public String getCurrentRouteName() {
        if (audioManager == null) return "Desconocido";
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                AudioDeviceInfo dev = audioManager.getCommunicationDevice();
                if (dev != null) {
                    String name = dev.getProductName() != null && !dev.getProductName().toString().isEmpty()
                            ? dev.getProductName().toString() : getDeviceTypeName(dev.getType());
                    return name;
                }
            }
            if (audioManager.isSpeakerphoneOn()) return "Altavoz Integrado";
            if (audioManager.isBluetoothScoOn() || audioManager.isBluetoothA2dpOn()) return "Bluetooth Manos Libres";
            if (audioManager.isWiredHeadsetOn()) return "Auriculares con cable";
        } catch (Exception ignored) {}
        return "Auricular / Normal";
    }

    private String getDeviceTypeName(int type) {
        switch (type) {
            case AudioDeviceInfo.TYPE_BUILTIN_EARPIECE: return "Auricular del teléfono";
            case AudioDeviceInfo.TYPE_BUILTIN_SPEAKER:  return "Altavoz Integrado";
            case AudioDeviceInfo.TYPE_WIRED_HEADSET:    return "Auricular con cable y mic";
            case AudioDeviceInfo.TYPE_WIRED_HEADPHONES: return "Auriculares sin mic";
            case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:    return "Bluetooth Manos Libres (SCO)";
            case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:   return "Bluetooth Audio (A2DP)";
            case AudioDeviceInfo.TYPE_BLE_HEADSET:      return "Bluetooth LE Headset";
            case AudioDeviceInfo.TYPE_USB_HEADSET:      return "Headset USB";
            case AudioDeviceInfo.TYPE_USB_DEVICE:       return "Dispositivo USB Audio";
            default: return "Dispositivo de audio (" + type + ")";
        }
    }
}
