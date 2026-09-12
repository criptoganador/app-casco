package com.example.appcasco.livekit;

import android.content.Context;
import android.location.Location;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import kotlinx.coroutines.BuildersKt;
import kotlinx.coroutines.CoroutineScope;
import kotlinx.coroutines.Dispatchers;
import kotlinx.coroutines.Job;
import kotlinx.coroutines.SupervisorKt;
import kotlinx.coroutines.flow.FlowKt;

import io.livekit.android.events.EventListenableKt;
import io.livekit.android.events.RoomEvent;
import kotlin.jvm.functions.Function2;

import io.livekit.android.ConnectOptions;
import io.livekit.android.LiveKit;
import io.livekit.android.LiveKitOverrides;
import io.livekit.android.RoomOptions;
import io.livekit.android.room.Room;
import io.livekit.android.room.participant.AudioTrackPublishDefaults;
import io.livekit.android.room.participant.LocalParticipant;
import io.livekit.android.room.participant.RemoteParticipant;
import io.livekit.android.room.participant.VideoTrackPublishDefaults;
import io.livekit.android.room.participant.VideoTrackPublishOptions;
import io.livekit.android.room.track.DataPublishReliability;
import io.livekit.android.room.track.LocalAudioTrackOptions;
import io.livekit.android.room.track.LocalVideoTrack;
import io.livekit.android.room.track.LocalVideoTrackOptions;
import io.livekit.android.room.track.RemoteAudioTrack;
import io.livekit.android.room.track.RemoteTrackPublication;
import io.livekit.android.room.track.Track;
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
    private Job roomEventsJob = null; // Job para cancelar la colección de eventos al detener

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

                    // Configuración de audio con cancelación de eco (AEC) y supresión de ruido (NS) activadas.
                    // Esto evita que el micrófono del celular capture la voz que sale por su propio altavoz y la reenvíe a la PC.
                    LocalAudioTrackOptions audioCaptureDefaults = new LocalAudioTrackOptions(
                            true,  // noiseSuppression
                            true,  // echoCancellation (AEC)
                            true,  // autoGainControl (AGC)
                            true,  // highPassFilter
                            false  // typingNoiseDetection
                    );
                    RoomOptions roomOptions = new RoomOptions(
                            false,
                            false,
                            null,
                            audioCaptureDefaults,
                            new LocalVideoTrackOptions(),
                            new AudioTrackPublishDefaults(),
                            new VideoTrackPublishDefaults(),
                            new LocalVideoTrackOptions(),
                            new VideoTrackPublishDefaults()
                    );
                    room = LiveKit.INSTANCE.create(context, roomOptions, new LiveKitOverrides());
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
                                configureAudioOutput();
                                // Suscribirse a eventos de la sala para recibir audio remoto de la PC
                                startRoomEventsCollection();
                                if (events != null) events.onConnected();
                                // Reproducir cualquier track remoto que ya esté publicado
                                subscribeToExistingRemoteTracks();
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

            // Habilitar y publicar audio del micrófono en LiveKit (debe correr en hilo principal)
            new Handler(Looper.getMainLooper()).post(() -> {
                Log.d(TAG, "Habilitando micrófono en hilo principal...");
                localParticipant.setMicrophoneEnabled(true, new Continuation<Unit>() {
                    @NonNull
                    @Override
                    public CoroutineContext getContext() {
                        return EmptyCoroutineContext.INSTANCE;
                    }

                    @Override
                    public void resumeWith(@NonNull Object result) {
                        if (result instanceof Result.Failure) {
                            Throwable ex = ((Result.Failure) result).exception;
                            Log.e(TAG, "ERROR habilitando micrófono en LiveKit: " + (ex != null ? ex.getMessage() : "desconocido"), ex);
                        } else {
                            Log.d(TAG, "¡MICRÓFONO ACTIVO! Audio transmitiendo en LiveKit (altavoces/manos libres/Bluetooth)");
                        }
                    }
                });
            });

        } catch (Exception e) {
            Log.e(TAG, "Error creando o publicando LocalVideoTrack", e);
            if (events != null) events.onError("Error publicando video: " + e.getMessage());
        }
    }

    /**
     * Suscribe a los eventos del Room usando el Flow de eventos de LiveKit SDK 2.x.
     * Detecta dinámicamente cuando la PC publica su micrófono para reproducirlo de inmediato en el casco.
     */
    private void startRoomEventsCollection() {
        if (room == null) return;
        if (roomEventsJob != null) {
            roomEventsJob.cancel(null);
            roomEventsJob = null;
        }

        CoroutineScope scope = kotlinx.coroutines.CoroutineScopeKt.CoroutineScope(
                Dispatchers.getIO().plus(SupervisorKt.SupervisorJob(null))
        );

        roomEventsJob = BuildersKt.launch(
                scope,
                Dispatchers.getIO(),
                kotlinx.coroutines.CoroutineStart.DEFAULT,
                new Function2<CoroutineScope, Continuation<? super Unit>, Object>() {
                    @Override
                    public Object invoke(CoroutineScope coroutineScope, Continuation<? super Unit> continuation) {
                        return EventListenableKt.collect(
                                room.getEvents(),
                                new Function2<RoomEvent, Continuation<? super Unit>, Object>() {
                                    @Override
                                    public Object invoke(RoomEvent event, Continuation<? super Unit> cont) {
                                        handleRoomEvent(event);
                                        return Unit.INSTANCE;
                                    }
                                },
                                continuation
                        );
                    }
                }
        );
        Log.d(TAG, "Escuchador de eventos de sala LiveKit iniciado para audio bidireccional");
    }

    /**
     * Procesa eventos de la sala de LiveKit para suscripción y reproducción de audio.
     */
    private void handleRoomEvent(RoomEvent event) {
        if (event instanceof RoomEvent.TrackSubscribed) {
            RoomEvent.TrackSubscribed e = (RoomEvent.TrackSubscribed) event;
            if (e.getTrack() instanceof RemoteAudioTrack) {
                final RemoteAudioTrack audioTrack = (RemoteAudioTrack) e.getTrack();
                final RemoteParticipant participant = e.getParticipant();
                final String name = (participant != null && participant.getName() != null)
                        ? participant.getName() : "PC / Remoto";
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        audioTrack.start();
                        Log.d(TAG, "▶ [AUDIO REMOTO RECIBIDO] Reproduciendo voz de: " + name);
                    } catch (Exception ex) {
                        Log.w(TAG, "Aviso al iniciar audio remoto:", ex);
                    }
                });
            }
        } else if (event instanceof RoomEvent.TrackUnsubscribed) {
            RoomEvent.TrackUnsubscribed e = (RoomEvent.TrackUnsubscribed) event;
            if (e.getTrack() instanceof RemoteAudioTrack) {
                final RemoteAudioTrack audioTrack = (RemoteAudioTrack) e.getTrack();
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        audioTrack.stop();
                    } catch (Exception ex) {
                        /* ignorar */
                    }
                    Log.d(TAG, "⏹ [AUDIO REMOTO DETENIDO]");
                });
            }
        }
    }

    /**
     * Verifica si ya hay participantes remotos con audio publicado al conectarse
     * (caso: la PC ya tenía el micrófono activo antes de que el casco se conecte).
     */
    private void subscribeToExistingRemoteTracks() {
        if (room == null) return;
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                for (RemoteParticipant participant : room.getRemoteParticipants().values()) {
                    for (TrackPublication pub : participant.getTrackPublications().values()) {
                        Track track = pub.getTrack();
                        if (track instanceof RemoteAudioTrack) {
                            try {
                                ((RemoteAudioTrack) track).start();
                                String name = participant.getName() != null ? participant.getName() : "PC / Remoto";
                                Log.d(TAG, "▶ [AUDIO REMOTO PREVIO] Reproduciendo voz de: " + name);
                            } catch (Exception e) {
                                Log.w(TAG, "Aviso reproduciendo audio remoto previo:", e);
                            }
                        }
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "Aviso en subscribeToExistingRemoteTracks:", e);
            }
        });
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

    private void configureAudioOutput() {
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                android.media.AudioManager audioManager = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
                if (audioManager != null) {
                    audioManager.setMode(android.media.AudioManager.MODE_IN_COMMUNICATION);
                    // Si no tiene auriculares conectados por cable ni bluetooth, activar altavoz para que se escuche fuerte
                    if (!audioManager.isWiredHeadsetOn() && !audioManager.isBluetoothA2dpOn() && !audioManager.isBluetoothScoOn()) {
                        audioManager.setSpeakerphoneOn(true);
                        Log.d(TAG, "Altavoz activado para recepción de audio de la PC");
                    }
                    int maxVol = audioManager.getStreamMaxVolume(android.media.AudioManager.STREAM_VOICE_CALL);
                    int curVol = audioManager.getStreamVolume(android.media.AudioManager.STREAM_VOICE_CALL);
                    if (curVol < (int)(maxVol * 0.6)) {
                        audioManager.setStreamVolume(android.media.AudioManager.STREAM_VOICE_CALL, (int)(maxVol * 0.70), 0);
                    }
                    Log.d(TAG, "Audio de comunicación configurado exitosamente");
                }
            } catch (Exception e) {
                Log.w(TAG, "Aviso configurando salida de audio:", e);
            }
        });
    }

    /**
     * Envía las coordenadas GPS del celular en tiempo real a los observadores en la PC
     * utilizando el WebRTC DataChannel de LiveKit con baja latencia y alta confiabilidad.
     */
    public void sendLocation(Location location) {
        if (!isConnected || room == null || location == null) return;
        final LocalParticipant localParticipant = room.getLocalParticipant();
        if (localParticipant == null) return;

        executor.execute(() -> {
            try {
                JSONObject json = new JSONObject();
                json.put("lat", location.getLatitude());
                json.put("lng", location.getLongitude());
                json.put("accuracy", location.hasAccuracy() ? location.getAccuracy() : 0.0f);
                json.put("speed", location.hasSpeed() ? location.getSpeed() * 3.6f : 0.0f); // m/s a km/h
                json.put("bearing", location.hasBearing() ? location.getBearing() : 0.0f);
                json.put("altitude", location.hasAltitude() ? location.getAltitude() : 0.0);
                json.put("time", location.getTime() > 0 ? location.getTime() : System.currentTimeMillis());

                byte[] data = json.toString().getBytes(StandardCharsets.UTF_8);

                localParticipant.publishData(
                        data,
                        DataPublishReliability.RELIABLE,
                        "location",
                        null,
                        new Continuation<Unit>() {
                            @NonNull
                            @Override
                            public CoroutineContext getContext() {
                                return EmptyCoroutineContext.INSTANCE;
                            }

                            @Override
                            public void resumeWith(@NonNull Object result) {
                                // Envoltorio Continuation para compatibilidad Java con suspend function
                            }
                        }
                );
            } catch (Exception e) {
                Log.w(TAG, "Aviso enviando datos GPS:", e);
            }
        });
    }

    /**
     * Detiene el streaming y desconecta la sesión de LiveKit.
     */
    public void stopStream() {
        isConnected = false;
        if (roomEventsJob != null) {
            roomEventsJob.cancel(null);
            roomEventsJob = null;
        }
        try {
            android.media.AudioManager audioManager = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                audioManager.setSpeakerphoneOn(false);
                audioManager.setMode(android.media.AudioManager.MODE_NORMAL);
            }
        } catch (Exception ignored) {}

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
