package com.example.appcasco.livekit;

import android.content.Context;

import livekit.org.webrtc.CapturerObserver;
import livekit.org.webrtc.SurfaceTextureHelper;
import livekit.org.webrtc.VideoCapturer;
import livekit.org.webrtc.VideoFrame;

/**
 * Capturador de video personalizado para LiveKit 2.x.
 * Recibe los fotogramas procesados desde la cámara USB externa (UVC)
 * y los inyecta en el codificador de LiveKit.
 *
 * NOTA: LiveKit SDK 2.x incluye WebRTC bajo el paquete "livekit.org.webrtc",
 * no "org.webrtc" directamente.
 */
public class UvcVideoCapturer implements VideoCapturer {

    private CapturerObserver capturerObserver;

    @Override
    public void initialize(SurfaceTextureHelper surfaceTextureHelper, Context applicationContext, CapturerObserver capturerObserver) {
        this.capturerObserver = capturerObserver;
    }

    @Override
    public void startCapture(int width, int height, int framerate) {
        // La cámara UVC es alimentada externamente por IFrameCallback de libuvc
    }

    @Override
    public void stopCapture() throws InterruptedException {
    }

    @Override
    public void changeCaptureFormat(int width, int height, int framerate) {
    }

    @Override
    public void dispose() {
        this.capturerObserver = null;
    }

    @Override
    public boolean isScreencast() {
        return false;
    }

    /**
     * Inyecta un fotograma VideoFrame en el pipeline de LiveKit/WebRTC.
     */
    public void onFrameCaptured(VideoFrame frame) {
        if (capturerObserver != null && frame != null) {
            capturerObserver.onFrameCaptured(frame);
        }
    }
}
