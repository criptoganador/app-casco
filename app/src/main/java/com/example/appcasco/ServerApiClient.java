package com.example.appcasco;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

public class ServerApiClient {
    public static final String ACTION_VALIDATION_UPDATE = "com.example.app.VALIDATION_UPDATE";
    public static final String EXTRA_VALIDATED_FRAME_COUNT = "com.example.app.EXTRA_VALIDATED_FRAME_COUNT";

    private static final String TAG = "ServerApiClient";
    private static final ServerApiClient INSTANCE = new ServerApiClient();

    private Context appContext;
    // CORRECCIÓN: Usar AtomicLong para contadores accedidos desde múltiples hilos.
    private final AtomicLong processedFrameCount = new AtomicLong(0);

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private ServerApiClient() {}

    public static ServerApiClient getInstance() {
        return INSTANCE;
    }

    /**
     * Inicializa el cliente con el contexto de la aplicación para poder enviar broadcasts.
     */
    public void init(Context context) {
        if (this.appContext == null) {
            this.appContext = context.getApplicationContext();
        }
    }

    public void validateFrame(byte[] frameData) {
        if (frameData == null || frameData.length == 0) return;

        executor.submit(() -> {
            boolean success = performRealFrameProcessing(frameData);

            if (success) {
                long currentCount = processedFrameCount.incrementAndGet();

                if (currentCount % 30 == 0) { // Cada 30 fotogramas
                    Log.d(TAG, "Fotogramas REALMENTE validados: " + currentCount);
                    notifyUi(currentCount);
                }
            }
        });
    }

    /**
     * ⚠️ Lógica donde se implementa la comunicación con el servidor.
     * Esta es la función que debe contener tu código real (ej: llamada a Retrofit/OkHttp, 
     * o ejecución de un modelo ML local).
     */
    private boolean performRealFrameProcessing(byte[] frameData) {
        // --- AQUÍ VA TU CÓDIGO REAL DE CONEXIÓN AL SERVIDOR O PROCESAMIENTO ---

        // Ejemplo de una llamada de red simulada (reemplazar con tu lógica):
        /* try {
            // Ejemplo: Cliente HTTP que envía frameData a tu endpoint
            // new MyHttpClient().send(frameData); 
            
            // Simulación de trabajo:
            Thread.sleep(50); // Simula 50ms de latencia o procesamiento
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error during real frame processing", e);
            return false;
        } 
        */

        // Mientras no implementes el código real, mantén esto:
        return true;
    }

    private void notifyUi(long count) {
        if (appContext != null) {
            Intent intent = new Intent(ACTION_VALIDATION_UPDATE);
            intent.putExtra(EXTRA_VALIDATED_FRAME_COUNT, count);
            appContext.sendBroadcast(intent);
        }
    }

    public long getProcessedFrameCount() {
        return processedFrameCount.get();
    }

    public void reset() {
        processedFrameCount.set(0);
    }

    public void shutdown() {
        executor.shutdownNow();
    }
}
