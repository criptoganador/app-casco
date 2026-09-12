package com.example.appcasco.livekit;

import android.content.Context;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;

import java.nio.ByteBuffer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import io.livekit.android.ConnectOptions;
import io.livekit.android.LiveKit;
import io.livekit.android.LiveKitOverrides;
import io.livekit.android.RoomOptions;
import io.livekit.android.room.Room;
import io.livekit.android.room.participant.LocalParticipant;
import io.livekit.android.room.participant.VideoTrackPublishOptions;
import io.livekit.android.room.track.LocalVideoTrack;
import io.livekit.android.room.track.LocalVideoTrackOptions;
import io.livekit.android.room.track.TrackPublication;
import kotlin.Result;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;
import livekit.org.webrtc.JavaI420Buffer;
import livekit.org.webrtc.VideoFrame;

/**
 * Administrador de streaming para LiveKit Cloud (SFU).
 * 100% Java estándar compatible con LiveKit SDK 2.x.
 */
public class LiveKitStreamManager {

    private static final String TAG = "LiveKitStreamMgr";

    public static final String LIVEKIT_URL = "wss://asicme-casco-xlxbe39o.livekit.cloud";
    public static final String LIVEKIT_API_KEY = "APIutSnBDwPrHSM";
    public static final String LIVEKIT_API_SECRET = "DYIeeEd4f2ljsCgOQN2wb7ypHErawhAmeEBm0gVq5TmD";

    public interface Events {
        void onConnected();
        void onStreamingStarted();
        void onDisconnected();
        void onError(String message);
    }

    private final Context context;
    private final Events events;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private Room room;
    private UvcVideoCapturer uvcCapturer;
    private LocalVideoTrack localVideoTrack;
    private volatile boolean isConnected = false;

    public LiveKitStreamManager(Context context, Events events) {
        this.context = context.getApplicationContext();
        this.events = events;
    }

    /**
     * Inicia la conexión a LiveKit Cloud en la sala especificada y publica el video.
     */
    public void startStream(final String roomName) {
        executor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    Log.d(TAG, "Iniciando LiveKit para sala: " + roomName);
                    String identity = "casco-" + Build.MODEL.replaceAll("\\s+", "-");
                    String token = LiveKitTokenGenerator.createPublisherToken(
                            LIVEKIT_API_KEY,
                            LIVEKIT_API_SECRET,
                            roomName,
                            identity
                    );

                    stopStream();

                    room = LiveKit.INSTANCE.create(context, new RoomOptions(), new LiveKitOverrides());
                    uvcCapturer = new UvcVideoCapturer();

                    // Conectar a LiveKit Cloud
                    room.connect(LIVEKIT_URL, token, new ConnectOptions(), new Continuation<Unit>() {
                        @NonNull
                        @Override
                        public CoroutineContext getContext() {
                            return EmptyCoroutineContext.INSTANCE;
                        }

                        @Override
                        public void resumeWith(@NonNull Object result) {
                            if (result instanceof Result.Failure) {
                                Throwable ex = ((Result.Failure) result).exception;
                                Log.e(TAG, "Fallo al conectar a LiveKit Cloud", ex);
                                if (events != null) events.onError("Fallo LiveKit: " + (ex != null ? ex.getMessage() : "Error"));
                            } else {
                                Log.d(TAG, "¡Conectado exitosamente a LiveKit Cloud!");
                                isConnected = true;
                                if (events != null) events.onConnected();
                                publishTrack();
                            }
                        }
                    });

                } catch (Exception e) {
                    Log.e(TAG, "Error iniciando LiveKit stream", e);
                    if (events != null) events.onError("Error iniciando LiveKit: " + e.getMessage());
                }
            }
        });
    }

    private void publishTrack() {
        if (room == null || uvcCapturer == null) return;
        final LocalParticipant localParticipant = room.getLocalParticipant();
        if (localParticipant == null) return;

        try {
            localVideoTrack = localParticipant.createVideoTrack("camera", uvcCapturer, new LocalVideoTrackOptions(), null);
            localVideoTrack.startCapture();
            Log.d(TAG, "LocalVideoTrack creado e inicializado con startCapture()");
            VideoTrackPublishOptions pubOptions = new VideoTrackPublishOptions();

            localParticipant.publishVideoTrack(
                    localVideoTrack,
                    pubOptions,
                    new LocalParticipant.PublishListener() {
                        @Override
                        public void onPublishSuccess(TrackPublication publication) {
                            Log.d(TAG, "¡Track de video publicado en LiveKit exitosamente!");
                            if (events != null) events.onStreamingStarted();
                        }

                        @Override
                        public void onPublishFailure(Exception ex) {
                            Log.e(TAG, "Error publicando videoTrack en LiveKit", ex);
                            if (events != null) events.onError("Fallo al publicar video: " + ex.getMessage());
                        }
                    },
                    new Continuation<Unit>() {
                        @NonNull
                        @Override
                        public CoroutineContext getContext() {
                            return EmptyCoroutineContext.INSTANCE;
                        }

                        @Override
                        public void resumeWith(@NonNull Object result) {
                            // LocalParticipant.PublishListener maneja el resultado de publicación
                        }
                    }
            );
        } catch (Exception e) {
            Log.e(TAG, "Error creando o publicando LocalVideoTrack", e);
            if (events != null) events.onError("Error publicando video: " + e.getMessage());
        }
    }

    /**
     * Inyecta un fotograma I420 proveniente de la cámara UVC.
     */
    public void pushI420Frame(ByteBuffer y, ByteBuffer u, ByteBuffer v, int width, int height, int rotation, long timestampNs) {
        if (!isConnected || uvcCapturer == null) return;

        try {
            JavaI420Buffer i420Buffer = JavaI420Buffer.allocate(width, height);
            ByteBuffer yDst = i420Buffer.getDataY();
            ByteBuffer uDst = i420Buffer.getDataU();
            ByteBuffer vDst = i420Buffer.getDataV();

            y.position(0);
            u.position(0);
            v.position(0);

            yDst.put(y);
            uDst.put(u);
            vDst.put(v);

            VideoFrame frame = new VideoFrame(i420Buffer, rotation, timestampNs);
            uvcCapturer.onFrameCaptured(frame);
            frame.release(); // Libera la referencia local, WebRTC retiene el buffer mientras codifica
        } catch (Exception e) {
            Log.e(TAG, "Error pasando fotograma a LiveKit", e);
        }
    }

    /**
     * Detiene el streaming y desconecta la sesión de LiveKit.
     */
    public void stopStream() {
        isConnected = false;
        try {
            if (localVideoTrack != null) {
                localVideoTrack.stop();
                localVideoTrack.dispose();
                localVideoTrack = null;
            }
            if (uvcCapturer != null) {
                uvcCapturer.dispose();
                uvcCapturer = null;
            }
            if (room != null) {
                room.disconnect();
                room = null;
            }
            if (events != null) events.onDisconnected();
            Log.d(TAG, "LiveKit stream detenido");
        } catch (Exception e) {
            Log.w(TAG, "Aviso cerrando LiveKit", e);
        }
    }

    public boolean isConnected() {
        return isConnected;
    }
}
