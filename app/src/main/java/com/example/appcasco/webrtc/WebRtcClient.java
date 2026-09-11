package com.example.appcasco.webrtc;

import android.content.Context;
import android.util.Log;

import org.webrtc.AudioSource;
import org.webrtc.AudioTrack;
import org.webrtc.DataChannel;
import org.webrtc.DefaultVideoDecoderFactory;
import org.webrtc.DefaultVideoEncoderFactory;
import org.webrtc.EglBase;
import org.webrtc.IceCandidate;
import org.webrtc.JavaI420Buffer;
import org.webrtc.MediaConstraints;
import org.webrtc.MediaStream; // Necesario para onAddTrack
import org.webrtc.PeerConnection;
import org.webrtc.PeerConnectionFactory;
import org.webrtc.RtpReceiver;
import org.webrtc.SdpObserver;
import org.webrtc.SessionDescription;
import org.webrtc.VideoFrame;
import org.webrtc.VideoSource;
import org.webrtc.VideoTrack;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class WebRtcClient {

    private static final String TAG = "WebRtcClient";

    public interface Events {
        void onLocalSdp(SessionDescription sdp);
        void onLocalIce(IceCandidate cand);
        void onIceConnectionStateChange(PeerConnection.IceConnectionState newState);
    }

    private final Context appContext;
    private final Events events;

    private PeerConnectionFactory factory;
    private PeerConnection pc;

    private EglBase eglBase;
    private VideoSource videoSource;
    private VideoTrack videoTrack;
    private AudioSource audioSource;
    private AudioTrack audioTrack;

    // CORRECCIÓN: Se eliminan las variables locales 'localSdp' y 'hasSentSdp'

    public WebRtcClient(Context ctx, Events events) {
        this.appContext = ctx.getApplicationContext();
        this.events = events;
        initFactoryAndPeer();
    }

    private void initFactoryAndPeer() {
        PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext).createInitializationOptions()
        );

        eglBase = EglBase.create();
        DefaultVideoEncoderFactory enc = new DefaultVideoEncoderFactory(eglBase.getEglBaseContext(), true, true);
        DefaultVideoDecoderFactory dec = new DefaultVideoDecoderFactory(eglBase.getEglBaseContext());

        factory = PeerConnectionFactory.builder()
                .setVideoEncoderFactory(enc)
                .setVideoDecoderFactory(dec)
                .createPeerConnectionFactory();

        videoSource = factory.createVideoSource(false);
        videoTrack = factory.createVideoTrack("ARDAMSv0", videoSource);
        videoTrack.setEnabled(true);

        audioSource = factory.createAudioSource(new MediaConstraints());
        audioTrack = factory.createAudioTrack("ARDAMSa0", audioSource);
        audioTrack.setEnabled(true);

        // --- Servidores Xirsys (STUN y TURN) ---
        List<PeerConnection.IceServer> iceServers = new ArrayList<>();

        // STUN
        iceServers.add(PeerConnection.IceServer.builder("stun:fr-turn1.xirsys.com").createIceServer());

        // TURN con credenciales (usando tus credenciales)
        iceServers.add(PeerConnection.IceServer.builder(new ArrayList<>(
                        Arrays.asList(
                                "turn:fr-turn1.xirsys.com:80?transport=udp",
                                "turn:fr-turn1.xirsys.com:3478?transport=udp",
                                "turn:fr-turn1.xirsys.com:80?transport=tcp",
                                "turn:fr-turn1.xirsys.com:3478?transport=tcp",
                                "turns:fr-turn1.xirsys.com:443?transport=tcp",
                                "turns:fr-turn1.xirsys.com:5349?transport=tcp"
                        )))
                .setUsername("cW2RvcBDKn9U7-rztljxT8QKu2qQAndfY8yx5gUykiZ3KAAhWqCJpR9ouXkAfbTUAAAAAGkSc-1qaG9hbkRldg==")
                .setPassword("41968e52-be8c-11f0-a581-b692af207303")
                .createIceServer());
        // ------------------------------------------

        PeerConnection.RTCConfiguration cfg = new PeerConnection.RTCConfiguration(iceServers);
        cfg.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;

        pc = factory.createPeerConnection(cfg, new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState newState) {}

            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState newState) {
                Log.d(TAG, "onIceConnectionChange: " + newState);
                if (events != null) {
                    events.onIceConnectionStateChange(newState);
                }
            }

            @Override public void onIceConnectionReceivingChange(boolean b) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState newState) {
                Log.d(TAG, "onIceGatheringChange: " + newState);
            }

            @Override public void onIceCandidate(IceCandidate candidate) {
                // CORRECCIÓN: Envía el candidato inmediatamente (Trickle ICE)
                Log.d(TAG, "onIceCandidate: Sending ICE candidate.");
                if (events != null) {
                    events.onLocalIce(candidate);
                }
            }

            @Override public void onIceCandidatesRemoved(IceCandidate[] c) {}

            @Override
            public void onAddStream(MediaStream stream) {

            }

            @Override
            public void onRemoveStream(MediaStream stream) {

            }

            // CORRECCIÓN: Se eliminan los métodos obsoletos onAddStream y onRemoveStream.
            // La funcionalidad de recepción se maneja en onAddTrack si este fuera el Receptor.

            @Override public void onDataChannel(DataChannel dc) {}
            @Override public void onRenegotiationNeeded() {}

            // Este es el método correcto para manejar la llegada de streams en UNIFIED_PLAN
            @Override public void onAddTrack(RtpReceiver r, MediaStream[] s) {}
        });

        if (pc != null) {
            // Se añaden los tracks de audio y video ANTES de crear la Oferta
            pc.addTrack(videoTrack);
            pc.addTrack(audioTrack);
        }
    }

    public void createOffer() {
        if (pc == null) return;
        MediaConstraints mc = new MediaConstraints();
        mc.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveAudio", "false"));
        mc.mandatory.add(new MediaConstraints.KeyValuePair("OfferToReceiveVideo", "false"));

        pc.createOffer(new SdpObserver() {
            @Override public void onCreateSuccess(SessionDescription sdp) {
                // CORRECCIÓN: setLocalDescription debe usarse para activar la recolección ICE
                // y su onSetSuccess debe usarse para enviar la Oferta a Firebase.
                pc.setLocalDescription(new SimpleSdpObserver() {
                    @Override public void onSetSuccess() {
                        Log.d(TAG, "Offer set locally. SIGNALLING SDP NOW.");
                        // Publica la Oferta inmediatamente después de establecerla localmente.
                        if (events != null) {
                            events.onLocalSdp(sdp);
                        }
                    }
                    @Override public void onSetFailure(String s) {
                        Log.e(TAG, "Failed to set local description: " + s);
                    }
                }, sdp);
            }

            // onSetSuccess no se usa aquí, ya que usamos el SdpObserver anónimo en setLocalDescription
            @Override public void onSetSuccess() {}
            @Override public void onCreateFailure(String s) {
                Log.e(TAG, "Failed to create offer: " + s);
            }
            @Override public void onSetFailure(String s) {}
        }, mc);
    }

    public void setRemoteDescription(SessionDescription sdp) {
        if (pc == null || sdp == null) return;

        // El Emisor (Android) aplica la Respuesta (Answer) del Receptor (PC).
        Log.d(TAG, "Setting remote description (Answer) from PC.");
        pc.setRemoteDescription(new SimpleSdpObserver() {
            @Override public void onSetSuccess() {
                Log.d(TAG, "Remote Answer set successfully. Negotiation complete.");
            }
            @Override public void onSetFailure(String s) {
                Log.e(TAG, "Failed to set remote description: " + s);
            }
        }, sdp);
    }

    public void addRemoteIce(IceCandidate cand) {
        if (pc == null || cand == null) return;
        // El Emisor aplica los candidatos ICE que vienen del Receptor (PC)
        pc.addIceCandidate(cand);
    }

    public void pushI420Frame(ByteBuffer y, ByteBuffer u, ByteBuffer v, int w, int h, int rot, long ts) {
        if (videoSource == null) return;
        JavaI420Buffer buf = JavaI420Buffer.wrap(w, h, y, w, u, w / 2, v, w / 2, () -> {});
        VideoFrame frame = new VideoFrame(buf, rot, ts);
        videoSource.getCapturerObserver().onFrameCaptured(frame);
        frame.release();
    }

    public void close() {
        try {
            if (pc != null) pc.close();
            if (videoTrack != null) videoTrack.dispose();
            if (videoSource != null) videoSource.dispose();
            if (audioTrack != null) audioTrack.dispose();
            if (audioSource != null) audioSource.dispose();
            if (factory != null) factory.dispose();
            if (eglBase != null) eglBase.release();
        } catch (Throwable ignore) {}
    }

    private static class SimpleSdpObserver implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription sdp) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String s) {}
        @Override public void onSetFailure(String s) {}
    }
}