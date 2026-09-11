package com.example.appcasco.webrtc;

import java.nio.ByteBuffer;

/**
 * Conversión NV21 (Y + VU intercalado) -> I420 (Y, U, V planar).
 * - Asume strides compactos: Y = width, UV = width.
 * - Preasigna Y/U/V una sola vez y reúsalos (clear/flip por frame).
 */
public final class FrameConverter {

    private FrameConverter() {}

    /** Versión con ByteBuffer fuente (pos=0, cap>=frame). Acepta direct o heap. */
    public static void nv21ToI420(ByteBuffer nv21, int width, int height,
                                  ByteBuffer yOut, ByteBuffer uOut, ByteBuffer vOut) {
        final int frameSize = width * height;
        final int chromaW = width >> 1;
        final int chromaH = height >> 1;

        // Garantiza lectura desde el inicio del buffer fuente
        int oldPos = nv21.position();
        nv21.position(0);

        // Y
        yOut.clear();
        if (nv21.hasArray()) {
            // camino rápido si es heap buffer
            byte[] arr = nv21.array();
            int off = nv21.arrayOffset();
            yOut.put(arr, off, frameSize);
        } else {
            // direct: copiar por bloques
            ByteBuffer ySlice = nv21.slice();
            ySlice.limit(frameSize);
            yOut.put(ySlice);
        }
        yOut.flip();

        // UV
        uOut.clear();
        vOut.clear();
        for (int row = 0; row < chromaH; row++) {
            int rowStart = frameSize + row * width;
            for (int col = 0; col < chromaW; col++) {
                int idx = rowStart + (col << 1);
                byte v = nv21.get(idx);
                byte u = nv21.get(idx + 1);
                uOut.put(u);
                vOut.put(v);
            }
        }
        uOut.flip();
        vOut.flip();

        nv21.position(oldPos);
    }
}
