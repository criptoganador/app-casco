package com.example.appcasco.webrtc;

import java.nio.ByteBuffer;

/**
 * Conversión NV21 (Y + VU intercalado) -> I420 (Y, U, V planar).
 * - Asume strides compactos: Y = width, UV = width.
 * - Preasigna Y/U/V una sola vez y reúsalos (clear/flip por frame).
 */
public final class FrameConverter {

    private static final ThreadLocal<byte[]> UV_BUFFER = new ThreadLocal<>();
    private static final ThreadLocal<byte[]> U_BUFFER = new ThreadLocal<>();
    private static final ThreadLocal<byte[]> V_BUFFER = new ThreadLocal<>();

    private static byte[] getOrCreateBuffer(ThreadLocal<byte[]> threadLocal, int requiredSize) {
        byte[] buf = threadLocal.get();
        if (buf == null || buf.length < requiredSize) {
            buf = new byte[requiredSize];
            threadLocal.set(buf);
        }
        return buf;
    }

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

        // UV optimizado con copiado en bloque
        uOut.clear();
        vOut.clear();
        final int chromaSize = chromaW * chromaH;
        final int uvSize = chromaSize * 2;

        byte[] uvBytes = getOrCreateBuffer(UV_BUFFER, uvSize);
        byte[] uBytes = getOrCreateBuffer(U_BUFFER, chromaSize);
        byte[] vBytes = getOrCreateBuffer(V_BUFFER, chromaSize);

        nv21.position(frameSize);
        nv21.get(uvBytes, 0, uvSize);

        for (int i = 0, j = 0; i < uvSize; i += 2, j++) {
            uBytes[j] = uvBytes[i];
            vBytes[j] = uvBytes[i + 1];
        }

        uOut.put(uBytes, 0, chromaSize);
        vOut.put(vBytes, 0, chromaSize);
        uOut.flip();
        vOut.flip();

        nv21.position(oldPos);
    }
}
