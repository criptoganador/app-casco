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

import com.example.appcasco.audio.AudioRouteManager;
import com.example.appcasco.network.NetworkConnectionManager;

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
import io.livekit.android.room.track.VideoCaptureParameter;
import io.livekit.android.room.track.VideoEncoding;
import kotlin.Result;
import kotlin.Unit;
import kotlin.coroutines.Continuation;
import kotlin.coroutines.CoroutineContext;
import kotlin.coroutines.EmptyCoroutineContext;
import livekit.org.webrtc.JavaI420Buffer;
import livekit.org.webrtc.RtpParameters;
import livekit.org.webrtc.VideoFrame;

/**
 * Administrador de streaming para LiveKit Cloud (SFU).
 * 100% Java estándar compatible con LiveKit SDK 2.x.
 */
public class LiveKitStreamManager {

    private static final String TAG = "LiveKitStreamMgr";

    public static final String LIVEKIT_URL = "wss://casco-nmlttzpb.livekit.cloud";
    public static final String LIVEKIT_API_KEY = "APIpjmsEDHpxCN8";
    public static final String LIVEKIT_API_SECRET = "fiDVGQeuyDwhlT3HZWHIHEO849OsweeTV4hwEBUemePJ";

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
    private volatile boolean isPublishing = false; // Evita publicar dos veces en paralelo
    private Job roomEventsJob = null; // Job para cancelar la colección de eventos al detener
    private final AudioRouteManager audioRouteManager;
    private final NetworkConnectionManager networkManager;
    private String currentRoomName = null;
    private volatile boolean isExplicitlyStopped = false;

    public LiveKitStreamManager(Context context, Events events) {
        this.context = context.getApplicationContext();
        this.events = events;
        this.audioRouteManager = new AudioRouteManager(this.context);
        this.networkManager = new NetworkConnectionManager(this.context);
        setupNetworkListener();
    }

    private void setupNetworkListener() {
        this.networkManager.setListener(new NetworkConnectionManager.NetworkStateListener() {
            @Override
            public void onNetworkAvailable(@NonNull NetworkConnectionManager.NetworkState state) {
                Log.d(TAG, "📡 [Red] Disponible: " + state.typeName);
                if (currentRoomName != null && !isExplicitlyStopped && (!isConnected || (room != null && room.getState() == Room.State.DISCONNECTED))) {
                    Log.i(TAG, "Reanudando sesión LiveKit tras disponibilidad de red...");
                    reconnectStream();
                }
            }

            @Override
            public void onNetworkLost() {
                Log.w(TAG, "⚠️ [Red] Pérdida de red detectada mientras se transmitía.");
                if (currentRoomName != null && !isExplicitlyStopped) {
                    networkManager.scheduleExponentialReconnect(() -> {
                        if (currentRoomName != null && !isExplicitlyStopped && (!isConnected || (room != null && room.getState() == Room.State.DISCONNECTED))) {
                            reconnectStream();
                        }
                    });
                }
            }

            @Override
            public void onNetworkValidated(@NonNull NetworkConnectionManager.NetworkState state) {
                Log.i(TAG, "🌍 [Red] Acceso a Internet VALIDADO por Google DNS: " + state.typeName);
                if (currentRoomName != null && !isExplicitlyStopped && (!isConnected || (room != null && room.getState() == Room.State.DISCONNECTED))) {
                    reconnectStream();
                }
            }

            @Override
            public void onHandover(@NonNull NetworkConnectionManager.NetworkState oldState, @NonNull NetworkConnectionManager.NetworkState newState) {
                Log.i(TAG, "🔄 [Red] Handover detectado: " + oldState.typeName + " ➔ " + newState.typeName);
                new Handler(Looper.getMainLooper()).postDelayed(() -> {
                    if (currentRoomName != null && !isExplicitlyStopped && room != null && room.getState() == Room.State.DISCONNECTED) {
                        Log.w(TAG, "Sala desconectada tras cambio de interfaz (Handover). Reconectando...");
                        reconnectStream();
                    }
                }, 3500);
            }
        });
    }

    private void reconnectStream() {
        if (currentRoomName == null || isExplicitlyStopped) return;
        Log.i(TAG, "⚡ Ejecutando reconexión automática a la sala: " + currentRoomName);
        startStream(currentRoomName);
    }

    public AudioRouteManager getAudioRouteManager() {
        return audioRouteManager;
    }

    public NetworkConnectionManager getNetworkManager() {
        return networkManager;
    }

    /**
     * Inicia la conexión a LiveKit Cloud en la sala especificada y publica el video.
     */
    public void startStream(final String roomName) {
        this.currentRoomName = roomName;
        this.isExplicitlyStopped = false;
        this.networkManager.startMonitoring();
        executor.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    String cleanRoomName = (roomName != null && !roomName.trim().isEmpty())
                            ? roomName.trim().replaceAll("[^a-zA-Z0-9_-]", "_")
                            : "jhoan";
                    String cleanModel = (Build.MODEL != null && !Build.MODEL.trim().isEmpty())
                            ? Build.MODEL.trim().replaceAll("[^a-zA-Z0-9_-]", "-")
                            : "android";
                    String identity = "casco-" + cleanModel;
                    Log.d(TAG, "Iniciando LiveKit para sala: " + cleanRoomName + " con identidad: " + identity);
                    String token = LiveKitTokenGenerator.createPublisherToken(
                            LIVEKIT_API_KEY,
                            LIVEKIT_API_SECRET,
                            cleanRoomName,
                            identity
                    );

                    // Libera la sesión anterior SIN alterar currentRoomName ni isExplicitlyStopped
                    // Esto evita el crash "MediaStreamTrack has been disposed" por desechar el capturer
                    // mientras una coroutine de conexión aún lo estaba referenciando.
                    teardownCurrentSession();

                    // Configuración de audio con cancelación de eco (AEC) y supresión de ruido (NS) activadas.
                    LocalAudioTrackOptions audioCaptureDefaults = new LocalAudioTrackOptions(
                            true,  // noiseSuppression
                            true,  // echoCancellation (AEC)
                            true,  // autoGainControl (AGC)
                            true,  // highPassFilter
                            false  // typingNoiseDetection
                    );
                    LocalVideoTrackOptions videoCaptureDefaults = new LocalVideoTrackOptions(
                            false,
                            null,
                            null,
                            new VideoCaptureParameter(640, 480, 30, true)
                    );
                    RoomOptions roomOptions = new RoomOptions(
                            true,   // adaptiveStream activado para optimizar consumo y latencia
                            true,   // dynacast activado: pausa resolución HD si ningún suscriptor la solicita
                            null,
                            audioCaptureDefaults,
                            videoCaptureDefaults,
                            new AudioTrackPublishDefaults(),
                            new VideoTrackPublishDefaults(),
                            new LocalVideoTrackOptions(),
                            new VideoTrackPublishDefaults()
                    );

                    // Crear nuevos objetos DESPUÉS de limpiar la sesión anterior
                    room = LiveKit.INSTANCE.create(context, roomOptions, new LiveKitOverrides());
                    uvcCapturer = new UvcVideoCapturer();
                    isPublishing = false;

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
                                // Iniciar gestión profesional de audio (enrutamiento + AEC + foco)
                                audioRouteManager.startCallAudio();
                                // Suscribirse a eventos de la sala para recibir audio remoto de la PC
                                startRoomEventsCollection();
                                if (events != null) events.onConnected();
                                // Reproducir cualquier track remoto que ya esté publicado
                                subscribeToExistingRemoteTracks();
                                // Forzar volumen al máximo DESPUÉS de que AudioRouteManager configure el modo
                                forceMaxCallVolume();
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

    /**
     * Libera la sesión LiveKit actual (track, capturer, room) sin modificar las banderas
     * de estado que controlan la lógica de reconexión automática.
     * Llamar siempre desde el hilo del executor antes de crear una nueva sesión.
     */
    private void teardownCurrentSession() {
        isConnected = false;
        isPublishing = false;
        if (roomEventsJob != null) {
            roomEventsJob.cancel(null);
            roomEventsJob = null;
        }
        try {
            if (localVideoTrack != null) {
                localVideoTrack.stop();
                localVideoTrack.dispose();
                localVideoTrack = null;
            }
        } catch (Exception e) {
            Log.w(TAG, "Aviso liberando localVideoTrack:", e);
        }
        try {
            if (uvcCapturer != null) {
                uvcCapturer.dispose();
                uvcCapturer = null;
            }
        } catch (Exception e) {
            Log.w(TAG, "Aviso liberando uvcCapturer:", e);
        }
        try {
            if (room != null) {
                room.disconnect();
                room = null;
            }
        } catch (Exception e) {
            Log.w(TAG, "Aviso desconectando room:", e);
        }
    }

    private void publishTrack() {
        if (room == null || uvcCapturer == null) return;
        if (isPublishing) {
            Log.w(TAG, "publishTrack() ignorado: ya se está publicando.");
            return;
        }
        isPublishing = true;
        final LocalParticipant localParticipant = room.getLocalParticipant();
        if (localParticipant == null) {
            isPublishing = false;
            return;
        }

        try {
            LocalVideoTrackOptions videoTrackOptions = new LocalVideoTrackOptions(
                    false,
                    null,
                    null,
                    new VideoCaptureParameter(640, 480, 30, true)
            );
            localVideoTrack = localParticipant.createVideoTrack("camera", uvcCapturer, videoTrackOptions, null);
            localVideoTrack.startCapture();
            Log.d(TAG, "LocalVideoTrack (UVC) creado e inicializado con startCapture()");

            // Opciones de publicación profesionales:
            // - Simulcast multicapa activado (alta, media, baja) para evitar cuellos de botella
            // - Codec VP8 acelerado por hardware WebRTC
            // - DegradationPreference: MAINTAIN_FRAMERATE para priorizar fluidez y mínima latencia sobre resolución
            VideoTrackPublishOptions pubOptions = new VideoTrackPublishOptions(
                    "camera",
                    new VideoEncoding(1_500_000, 30),
                    true,
                    "VP8",
                    null,
                    null,
                    Track.Source.CAMERA,
                    null,
                    RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
            );

            localParticipant.publishVideoTrack(
                    localVideoTrack,
                    pubOptions,
                    new LocalParticipant.PublishListener() {
                        @Override
                        public void onPublishSuccess(TrackPublication publication) {
                            Log.d(TAG, "¡Track de video UVC publicado en LiveKit exitosamente!");
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
     * Pausa y despublica la pista de video de la cámara USB externa cuando el cable OTG se desconecta.
     * Mantiene activa la sesión LiveKit, el audio bidireccional y el GPS sin usar la cámara del teléfono.
     */
    public void pauseUvcVideo() {
        executor.execute(() -> {
            if (room == null || !isConnected) return;
            Log.i(TAG, "⏸️ [PAUSA UVC] Despublicando pista de video de cámara USB (cable desconectado)...");
            final LocalParticipant localParticipant = room.getLocalParticipant();
            if (localParticipant == null) return;

            try {
                if (localVideoTrack != null) {
                    localParticipant.unpublishTrack(localVideoTrack, true);
                    localVideoTrack.stopCapture();
                    localVideoTrack.dispose();
                    localVideoTrack = null;
                }
            } catch (Throwable t) {
                Log.w(TAG, "Aviso liberando localVideoTrack en pausa:", t);
            }

            try {
                if (uvcCapturer != null) {
                    uvcCapturer.dispose();
                    uvcCapturer = null;
                }
            } catch (Throwable t) {
                Log.w(TAG, "Aviso liberando uvcCapturer en pausa:", t);
            }
        });
    }

    /**
     * Reanuda la captura y publicación de la cámara USB externa cuando se vuelve a conectar el cable OTG.
     */
    public void resumeUvcVideo() {
        executor.execute(() -> {
            if (room == null || !isConnected) return;
            Log.i(TAG, "▶️ [HOT-PLUG] Reanudando transmisión de video desde la cámara USB externa...");
            final LocalParticipant localParticipant = room.getLocalParticipant();
            if (localParticipant == null) return;

            try {
                if (localVideoTrack != null) {
                    localParticipant.unpublishTrack(localVideoTrack, true);
                    localVideoTrack.stopCapture();
                    localVideoTrack.dispose();
                    localVideoTrack = null;
                }
            } catch (Throwable t) {
                Log.w(TAG, "Aviso liberando track previo antes de reanudar:", t);
            }

            if (uvcCapturer == null) {
                uvcCapturer = new UvcVideoCapturer();
            }

            try {
                LocalVideoTrackOptions videoTrackOptions = new LocalVideoTrackOptions(
                        false,
                        null,
                        null,
                        new VideoCaptureParameter(640, 480, 30, true)
                );
                localVideoTrack = localParticipant.createVideoTrack("camera", uvcCapturer, videoTrackOptions, null);
                localVideoTrack.startCapture();
                Log.i(TAG, "✅ LocalVideoTrack UVC recreado e iniciado con startCapture()");

                VideoTrackPublishOptions pubOptions = new VideoTrackPublishOptions(
                        "camera",
                        new VideoEncoding(1_500_000, 30),
                        true,
                        "VP8",
                        null,
                        null,
                        Track.Source.CAMERA,
                        null,
                        RtpParameters.DegradationPreference.MAINTAIN_FRAMERATE
                );

                localParticipant.publishVideoTrack(
                        localVideoTrack,
                        pubOptions,
                        new LocalParticipant.PublishListener() {
                            @Override
                            public void onPublishSuccess(TrackPublication publication) {
                                Log.i(TAG, "¡Track de video UVC restaurado en LiveKit exitosamente!");
                                if (events != null) events.onStreamingStarted();
                            }

                            @Override
                            public void onPublishFailure(Exception ex) {
                                Log.e(TAG, "Error publicando videoTrack UVC tras reconexión", ex);
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
                            }
                        }
                );
            } catch (Throwable e) {
                Log.e(TAG, "Error reanudando video UVC:", e);
            }
        });
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
     * Procesa eventos de la sala de LiveKit para suscripción y reproducción de audio en modo conferencia grupal.
     * Permite que todos los cascos y el operador de PC se escuchen entre sí simultáneamente.
     */
    private void handleRoomEvent(RoomEvent event) {
        if (event instanceof RoomEvent.TrackSubscribed) {
            RoomEvent.TrackSubscribed e = (RoomEvent.TrackSubscribed) event;
            if (e.getTrack() instanceof RemoteAudioTrack) {
                final RemoteAudioTrack audioTrack = (RemoteAudioTrack) e.getTrack();
                final RemoteParticipant participant = e.getParticipant();
                final String name = (participant != null && participant.getName() != null && !participant.getName().isEmpty())
                        ? participant.getName() : "Remoto";
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        // Siempre llamar start() — LiveKit SDK es idempotente para tracks ya activos
                        audioTrack.start();
                        // Garantizar volumen al máximo cada vez que llega audio nuevo
                        forceMaxCallVolume();
                        Log.d(TAG, "▶ [AUDIO CONFERENCIA RECIBIDO] Reproduciendo voz de: " + name);
                    } catch (Exception ex) {
                        Log.w(TAG, "Aviso al iniciar audio de conferencia:", ex);
                    }
                });
            }
        } else if (event instanceof RoomEvent.TrackPublished) {
            // Cuando un nuevo participante o la PC publica su micrófono, forzar auto-suscripción inmediata
            RoomEvent.TrackPublished e = (RoomEvent.TrackPublished) event;
            if (e.getPublication() instanceof RemoteTrackPublication) {
                final RemoteTrackPublication pub = (RemoteTrackPublication) e.getPublication();
                pub.setSubscribed(true);
                Log.d(TAG, "🎧 [AUTO-SUSCRIPCIÓN] Suscrito a publicación: " + pub.getSid());
                // Si el track ya existe (publicado antes de suscribirse), iniciarlo de inmediato
                new Handler(Looper.getMainLooper()).post(() -> {
                    try {
                        if (pub.getTrack() instanceof RemoteAudioTrack) {
                            ((RemoteAudioTrack) pub.getTrack()).start();
                            forceMaxCallVolume();
                            Log.d(TAG, "▶ [AUDIO] Track ya disponible al suscribirse, iniciado.");
                        }
                    } catch (Exception ex) {
                        Log.w(TAG, "Aviso iniciando track en TrackPublished:", ex);
                    }
                });
            }
        } else if (event instanceof RoomEvent.ParticipantConnected) {
            // Cuando un nuevo casco o PC se une a la llamada, suscribirse a todo su audio
            RoomEvent.ParticipantConnected e = (RoomEvent.ParticipantConnected) event;
            final RemoteParticipant participant = e.getParticipant();
            final String name = (participant != null && participant.getName() != null && !participant.getName().isEmpty())
                    ? participant.getName() : "Participante";
            Log.i(TAG, "👤 [CONFERENCIA] Nuevo participante unido a la sala: " + name);
            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    for (TrackPublication pub : participant.getTrackPublications().values()) {
                        if (pub instanceof RemoteTrackPublication) {
                            ((RemoteTrackPublication) pub).setSubscribed(true);
                        }
                        if (pub.getTrack() instanceof RemoteAudioTrack) {
                            ((RemoteAudioTrack) pub.getTrack()).start();
                            Log.d(TAG, "▶ [AUDIO CONFERENCIA] Enlazado audio de: " + name);
                        }
                    }
                } catch (Exception ex) {
                    Log.w(TAG, "Aviso suscribiendo participante en conferencia:", ex);
                }
            });
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
                    Log.d(TAG, "⏹ [AUDIO CONFERENCIA DETENIDO]");
                });
            }
        } else if (event instanceof RoomEvent.Reconnecting) {
            Log.w(TAG, "🔄 LiveKit SDK reconectando socket internamente...");
        } else if (event instanceof RoomEvent.Reconnected) {
            Log.i(TAG, "✅ LiveKit SDK reconectado exitosamente.");
            if (events != null) events.onConnected();
            subscribeToExistingRemoteTracks();
        } else if (event instanceof RoomEvent.Disconnected) {
            Log.w(TAG, "LiveKit sala desconectada.");
            if (currentRoomName != null && !isExplicitlyStopped && networkManager.isInternetValidated()) {
                networkManager.scheduleExponentialReconnect(this::reconnectStream);
            }
        }
    }

    /**
     * Verifica y conecta de inmediato todos los participantes remotos con audio existente al unirse a la sala.
     * Garantiza que si el operador de PC u otros cascos ya estaban hablando, se escuchen inmediatamente.
     */
    private void subscribeToExistingRemoteTracks() {
        if (room == null) return;
        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                for (RemoteParticipant participant : room.getRemoteParticipants().values()) {
                    String name = (participant.getName() != null && !participant.getName().isEmpty())
                            ? participant.getName() : "Participante";
                    for (TrackPublication pub : participant.getTrackPublications().values()) {
                        if (pub instanceof RemoteTrackPublication) {
                            ((RemoteTrackPublication) pub).setSubscribed(true);
                        }
                        Track track = pub.getTrack();
                        if (track instanceof RemoteAudioTrack) {
                            try {
                                ((RemoteAudioTrack) track).start();
                                Log.d(TAG, "▶ [AUDIO CONFERENCIA ACTIVO] Reproduciendo voz de: " + name);
                            } catch (Exception e) {
                                Log.w(TAG, "Aviso reproduciendo audio de: " + name, e);
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
        // Guardas de seguridad: no procesar frames si no está conectado, no está publicando
        // o si el capturer ya fue liberado durante la desconexión física del cable
        if (!isConnected || !isPublishing || uvcCapturer == null || localVideoTrack == null) return;

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
     * Fuerza el volumen de llamada al máximo disponible.
     * Se llama en cada evento de audio nuevo para asegurar que todos los participantes
     * sean escuchados con el volumen correcto en modo conferencia.
     */
    private void forceMaxCallVolume() {
        try {
            android.media.AudioManager audioManager = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                int maxVol = audioManager.getStreamMaxVolume(android.media.AudioManager.STREAM_VOICE_CALL);
                // Siempre poner al 100% para conferencia grupal — el usuario puede bajar desde el HW
                audioManager.setStreamVolume(android.media.AudioManager.STREAM_VOICE_CALL, maxVol, 0);
                Log.d(TAG, "🔊 [CONFERENCIA] Volumen de llamada forzado al máximo: " + maxVol + "/" + maxVol);
            }
        } catch (Exception e) {
            Log.w(TAG, "Aviso ajustando volumen de llamada:", e);
        }
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
     * Elimina activamente la sala en LiveKit Cloud vía API REST Twirp al colgar o detener.
     * Esto expulsa de inmediato a cualquier participante colgado y libera los cupos de LiveKit en 0 segundos.
     */
    private void deleteRoomViaApi(final String roomName) {
        if (roomName == null || roomName.trim().isEmpty()) return;
        new Thread(() -> {
            try {
                String adminToken = LiveKitTokenGenerator.createAdminToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
                String apiUrl = LIVEKIT_URL.replace("wss://", "https://").replace("ws://", "http://")
                        + "/twirp/livekit.RoomService/DeleteRoom";
                java.net.URL url = new java.net.URL(apiUrl);
                java.net.HttpURLConnection conn = (java.net.HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Authorization", "Bearer " + adminToken);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);

                JSONObject body = new JSONObject();
                body.put("room", roomName.trim());
                try (java.io.OutputStream os = conn.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }

                int respCode = conn.getResponseCode();
                Log.i(TAG, "🧹 Sala '" + roomName + "' eliminada automáticamente de LiveKit Cloud. Código HTTP: " + respCode);
                conn.disconnect();
            } catch (Exception e) {
                Log.w(TAG, "Aviso eliminando sala en LiveKit vía API:", e);
            }
        }).start();
    }

    /**
     * Detiene el streaming y desconecta la sesión de LiveKit, purgando la sala en la nube.
     */
    public void stopStream() {
        isExplicitlyStopped = true;
        final String roomToDelete = currentRoomName;
        currentRoomName = null;
        if (networkManager != null) {
            networkManager.cancelPendingReconnect();
            networkManager.stopMonitoring();
        }
        if (audioRouteManager != null) {
            audioRouteManager.stopCallAudio();
        }
        try {
            android.media.AudioManager audioManager = (android.media.AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (audioManager != null) {
                audioManager.setSpeakerphoneOn(false);
                audioManager.setMode(android.media.AudioManager.MODE_NORMAL);
            }
        } catch (Exception ignored) {}

        executor.execute(() -> {
            teardownCurrentSession();
            if (roomToDelete != null) {
                deleteRoomViaApi(roomToDelete);
            }
            if (events != null) events.onDisconnected();
            Log.d(TAG, "LiveKit stream detenido y sala purgada automáticamente.");
        });
    }

    public boolean isConnected() {
        return isConnected;
    }
}
