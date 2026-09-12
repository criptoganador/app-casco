package com.example.appcasco.network;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

/**
 * Gestor profesional de conectividad de red para aplicaciones en tiempo real (VoIP / Streaming).
 *
 * Características principales:
 * 1. Monitoreo reactivo mediante ConnectivityManager.NetworkCallback (sin consumo innecesario de batería).
 * 2. Validación de acceso real a Internet mediante NET_CAPABILITY_VALIDATED (evita Wi-Fi "fantasma" o portales cautivos).
 * 3. Detección instantánea de cambio de interfaz (Handover transparente: Wi-Fi <-> 4G/5G).
 * 4. Algoritmo de reconexión con Retroceso Exponencial (Exponential Backoff) para túneles o zonas sin cobertura.
 * 5. 100% compatible con Java 11 y Android 7.0 a 15+.
 */
public class NetworkConnectionManager {

    private static final String TAG = "NetworkConnManager";

    // Constantes para Exponential Backoff
    private static final long INITIAL_BACKOFF_MS = 1000;  // 1 segundo
    private static final long MAX_BACKOFF_MS     = 16000; // 16 segundos máximo
    private static final double BACKOFF_MULTIPLIER = 2.0;

    /**
     * Objeto inmutable que representa el estado completo de la conexión.
     */
    public static class NetworkState {
        public final boolean isConnected;
        public final boolean isWifi;
        public final boolean isCellular;
        public final boolean isEthernet;
        public final boolean isValidated;
        public final String typeName;

        public NetworkState(boolean isConnected, boolean isWifi, boolean isCellular, boolean isEthernet, boolean isValidated) {
            this.isConnected = isConnected;
            this.isWifi = isWifi;
            this.isCellular = isCellular;
            this.isEthernet = isEthernet;
            this.isValidated = isValidated;

            if (!isConnected) {
                this.typeName = "Sin Conexión";
            } else if (isWifi) {
                this.typeName = isValidated ? "Wi-Fi (Validado)" : "Wi-Fi (Sin Internet)";
            } else if (isCellular) {
                this.typeName = isValidated ? "Datos Móviles (4G/5G)" : "Datos Móviles (Sin Internet)";
            } else if (isEthernet) {
                this.typeName = "Ethernet";
            } else {
                this.typeName = "Conectado";
            }
        }

        public static NetworkState disconnected() {
            return new NetworkState(false, false, false, false, false);
        }

        @NonNull
        @Override
        public String toString() {
            return "NetworkState{" +
                    "connected=" + isConnected +
                    ", type='" + typeName + '\'' +
                    ", validated=" + isValidated +
                    ", wifi=" + isWifi +
                    ", cellular=" + isCellular +
                    '}';
        }
    }

    /**
     * Interfaz de escucha de eventos de red para la UI y administradores de streaming.
     */
    public interface NetworkStateListener {
        void onNetworkAvailable(@NonNull NetworkState state);
        void onNetworkLost();
        void onNetworkValidated(@NonNull NetworkState state);
        void onHandover(@NonNull NetworkState oldState, @NonNull NetworkState newState);
    }

    private final Context context;
    private final ConnectivityManager connectivityManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private NetworkStateListener listener;

    private volatile NetworkState currentState = NetworkState.disconnected();
    private boolean isMonitoring = false;

    // Control de Exponential Backoff
    private long currentBackoffMs = INITIAL_BACKOFF_MS;
    private Runnable pendingReconnectTask = null;
    private final Object backoffLock = new Object();

    // Callback nativo de conectividad del sistema
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(@NonNull Network network) {
            Log.d(TAG, "📡 Red física disponible (onAvailable): " + network);
            evaluateNetwork(network, false);
        }

        @Override
        public void onLost(@NonNull Network network) {
            Log.w(TAG, "⚠️ Red perdida por completo (onLost): " + network);
            mainHandler.post(() -> {
                // Verificar si queda alguna otra red activa disponible en el dispositivo
                checkCurrentActiveNetwork();
            });
        }

        @Override
        public void onCapabilitiesChanged(@NonNull Network network, @NonNull NetworkCapabilities capabilities) {
            boolean isWifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
            boolean isCellular = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
            boolean isEthernet = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
            boolean isValidated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
            boolean hasInternet = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);

            if (!hasInternet) {
                handleDisconnected();
                return;
            }

            NetworkState newState = new NetworkState(true, isWifi, isCellular, isEthernet, isValidated);
            updateState(newState);
        }

        @Override
        public void onUnavailable() {
            Log.w(TAG, "⚠️ Red no disponible según los criterios del NetworkRequest");
            handleDisconnected();
        }
    };

    public NetworkConnectionManager(@NonNull Context context) {
        this.context = context.getApplicationContext();
        this.connectivityManager = (ConnectivityManager) this.context.getSystemService(Context.CONNECTIVITY_SERVICE);
    }

    public void setListener(@Nullable NetworkStateListener listener) {
        this.listener = listener;
    }

    /**
     * Inicia la escucha continua y en tiempo real de cambios de red.
     */
    public synchronized void startMonitoring() {
        if (isMonitoring || connectivityManager == null) return;

        try {
            NetworkRequest.Builder builder = new NetworkRequest.Builder()
                    .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
                    .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                builder.addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET);
            }

            connectivityManager.registerNetworkCallback(builder.build(), networkCallback);
            isMonitoring = true;
            Log.d(TAG, "NetworkCallback registrado exitosamente para monitoreo de red");

            // Evaluar estado inmediato inicial
            checkCurrentActiveNetwork();

        } catch (Exception e) {
            Log.e(TAG, "Error registrando NetworkCallback:", e);
            handleDisconnected();
        }
    }

    /**
     * Detiene el monitoreo y cancela reintentos pendientes.
     */
    public synchronized void stopMonitoring() {
        if (!isMonitoring || connectivityManager == null) return;

        try {
            connectivityManager.unregisterNetworkCallback(networkCallback);
            isMonitoring = false;
            cancelPendingReconnect();
            Log.d(TAG, "NetworkCallback desregistrado de forma limpia");
        } catch (Exception e) {
            Log.w(TAG, "Aviso desregistrando NetworkCallback:", e);
        }
    }

    /**
     * Evalúa el estado de la red activa actual.
     */
    public void checkCurrentActiveNetwork() {
        if (connectivityManager == null) {
            handleDisconnected();
            return;
        }

        try {
            Network activeNetwork = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                activeNetwork = connectivityManager.getActiveNetwork();
            }

            if (activeNetwork != null) {
                evaluateNetwork(activeNetwork, true);
            } else {
                handleDisconnected();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error verificando red activa:", e);
            handleDisconnected();
        }
    }

    private void evaluateNetwork(@NonNull Network network, boolean isInitial) {
        if (connectivityManager == null) return;

        try {
            NetworkCapabilities capabilities = connectivityManager.getNetworkCapabilities(network);
            if (capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) {
                boolean isWifi = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
                boolean isCellular = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
                boolean isEthernet = capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
                boolean isValidated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);

                NetworkState newState = new NetworkState(true, isWifi, isCellular, isEthernet, isValidated);
                updateState(newState);
            } else {
                handleDisconnected();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error evaluando capacidades de red:", e);
            handleDisconnected();
        }
    }

    private void updateState(@NonNull NetworkState newState) {
        mainHandler.post(() -> {
            NetworkState oldState = currentState;
            currentState = newState;

            Log.d(TAG, "Estado de red actualizado: " + newState.typeName + " (Validada: " + newState.isValidated + ")");

            // Detectar Handover (Cambio de Wi-Fi a Datos Móviles o viceversa)
            if (oldState.isConnected && newState.isConnected) {
                if (oldState.isWifi != newState.isWifi || oldState.isCellular != newState.isCellular) {
                    Log.i(TAG, "🔄 Handover detectado: " + oldState.typeName + " ➔ " + newState.typeName);
                    if (listener != null) {
                        listener.onHandover(oldState, newState);
                    }
                }
            }

            // Notificar disponibilidad general
            if (!oldState.isConnected && newState.isConnected) {
                Log.i(TAG, "✅ Conexión recuperada: " + newState.typeName);
                resetBackoff();
                // Si había una reconexión programada por backoff, ejecutarla de inmediato
                triggerImmediateReconnectIfPending();

                if (listener != null) {
                    listener.onNetworkAvailable(newState);
                }
            }

            // Notificar validación de Internet (acceso real comprobado)
            if (!oldState.isValidated && newState.isValidated) {
                Log.i(TAG, "🌍 Acceso real a Internet VALIDADO por Google DNS/HTTP");
                resetBackoff();
                triggerImmediateReconnectIfPending();

                if (listener != null) {
                    listener.onNetworkValidated(newState);
                }
            }
        });
    }

    private void handleDisconnected() {
        mainHandler.post(() -> {
            if (currentState.isConnected) {
                Log.w(TAG, "❌ Conexión a Internet PERDIDA");
                currentState = NetworkState.disconnected();
                if (listener != null) {
                    listener.onNetworkLost();
                }
            }
        });
    }

    // ─────────────────────────────────────────────
    // ALGORITMO DE RECONEXIÓN CON EXPONENTIAL BACKOFF
    // ─────────────────────────────────────────────

    /**
     * Programa un intento de reconexión aplicando retroceso exponencial (1s, 2s, 4s, 8s, 16s).
     * Evita saturar la CPU y batería cuando el conductor atraviesa un túnel o zona muerta.
     *
     * @param reconnectAction La acción a ejecutar (ej. liveKitManager.startStream()).
     */
    public void scheduleExponentialReconnect(@NonNull Runnable reconnectAction) {
        synchronized (backoffLock) {
            cancelPendingReconnect();

            final long delay = currentBackoffMs;
            Log.d(TAG, "⏳ Programando reintento de reconexión en " + (delay / 1000.0) + " segundos (Backoff)");

            pendingReconnectTask = () -> {
                synchronized (backoffLock) {
                    pendingReconnectTask = null;
                }
                Log.d(TAG, "⚡ Ejecutando reintento de reconexión programado");
                reconnectAction.run();
            };

            mainHandler.postDelayed(pendingReconnectTask, delay);

            // Incrementar backoff para el siguiente intento si este falla
            currentBackoffMs = Math.min((long) (currentBackoffMs * BACKOFF_MULTIPLIER), MAX_BACKOFF_MS);
        }
    }

    /**
     * Si la red regresa con validación real antes de que expire el temporizador de backoff,
     * ejecuta la reconexión de inmediato para no hacer esperar al usuario.
     */
    private void triggerImmediateReconnectIfPending() {
        synchronized (backoffLock) {
            if (pendingReconnectTask != null) {
                Log.d(TAG, "⚡ Red restaurada antes de expirar el backoff: ejecutando reconexión inmediata");
                mainHandler.removeCallbacks(pendingReconnectTask);
                Runnable task = pendingReconnectTask;
                pendingReconnectTask = null;
                task.run();
            }
        }
    }

    public void resetBackoff() {
        synchronized (backoffLock) {
            currentBackoffMs = INITIAL_BACKOFF_MS;
        }
    }

    public void cancelPendingReconnect() {
        synchronized (backoffLock) {
            if (pendingReconnectTask != null) {
                mainHandler.removeCallbacks(pendingReconnectTask);
                pendingReconnectTask = null;
            }
        }
    }

    // ─────────────────────────────────────────────
    // GETTERS DE ESTADO INMEDIATO
    // ─────────────────────────────────────────────

    @NonNull
    public NetworkState getCurrentState() {
        return currentState;
    }

    public boolean isConnected() {
        return currentState.isConnected;
    }

    public boolean isInternetValidated() {
        return currentState.isValidated;
    }

    public boolean isWifi() {
        return currentState.isWifi;
    }

    public boolean isCellular() {
        return currentState.isCellular;
    }

    public String getNetworkTypeName() {
        return currentState.typeName;
    }
}
