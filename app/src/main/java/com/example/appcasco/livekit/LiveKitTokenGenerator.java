package com.example.appcasco.livekit;

import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Generador autónomo de tokens JWT para LiveKit Cloud.
 * Firma tokens HMAC-SHA256 válidos sin requerir un servidor backend intermedio.
 */
public final class LiveKitTokenGenerator {

    private static final String TAG = "LiveKitTokenGen";

    private LiveKitTokenGenerator() {}

    /**
     * Genera un token JWT con permisos de publicación (para la app móvil del casco).
     *
     * @param apiKey    LIVEKIT_API_KEY
     * @param apiSecret LIVEKIT_API_SECRET
     * @param roomName  Nombre de la sala (ej: "jhoan")
     * @param identity  Identificador del participante (ej: "casco-android")
     * @return Token JWT firmado
     */
    public static String createPublisherToken(String apiKey, String apiSecret, String roomName, String identity) {
        try {
            JSONObject header = new JSONObject();
            header.put("alg", "HS256");
            header.put("typ", "JWT");

            long nowSeconds = System.currentTimeMillis() / 1000L;
            JSONObject payload = new JSONObject();
            payload.put("exp", nowSeconds + 24 * 3600); // Válido por 24 horas
            payload.put("iss", apiKey);
            payload.put("nbf", nowSeconds - 300); // Buffer de 5 minutos contra desfase de reloj del celular (NTP skew)
            payload.put("sub", identity);

            JSONObject video = new JSONObject();
            video.put("room", roomName);
            video.put("roomJoin", true);
            video.put("canPublish", true);
            video.put("canPublishData", true);
            video.put("canSubscribe", true);
            payload.put("video", video);

            String encHeader = base64Url(header.toString().getBytes(StandardCharsets.UTF_8));
            String encPayload = base64Url(payload.toString().getBytes(StandardCharsets.UTF_8));
            String dataToSign = encHeader + "." + encPayload;

            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec secretKey = new SecretKeySpec(apiSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            mac.init(secretKey);
            byte[] signature = mac.doFinal(dataToSign.getBytes(StandardCharsets.UTF_8));
            String encSignature = base64Url(signature);

            return dataToSign + "." + encSignature;

        } catch (Exception e) {
            Log.e(TAG, "Error generando token LiveKit", e);
            throw new RuntimeException("Error creando token LiveKit: " + e.getMessage(), e);
        }
    }

    /**
     * Genera un token JWT de administrador para gestión de salas (DeleteRoom, ListRooms) vía API Twirp.
     */
    public static String createAdminToken(String apiKey, String apiSecret) {
        try {
            JSONObject header = new JSONObject();
            header.put("alg", "HS256");
            header.put("typ", "JWT");

            long nowSeconds = System.currentTimeMillis() / 1000L;
            JSONObject payload = new JSONObject();
            payload.put("exp", nowSeconds + 300); // 5 minutos de vigencia
            payload.put("iss", apiKey);
            payload.put("nbf", nowSeconds - 5);
            payload.put("sub", "admin-casco");

            JSONObject video = new JSONObject();
            video.put("roomAdmin", true);
            video.put("roomList", true);
            video.put("roomCreate", true);
            payload.put("video", video);

            String encHeader = base64Url(header.toString().getBytes(StandardCharsets.UTF_8));
            String encPayload = base64Url(payload.toString().getBytes(StandardCharsets.UTF_8));
            String dataToSign = encHeader + "." + encPayload;

            Mac mac = Mac.getInstance("HmacSHA256");
            SecretKeySpec secretKey = new SecretKeySpec(apiSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256");
            mac.init(secretKey);
            byte[] signature = mac.doFinal(dataToSign.getBytes(StandardCharsets.UTF_8));
            String encSignature = base64Url(signature);

            return dataToSign + "." + encSignature;

        } catch (Exception e) {
            Log.e(TAG, "Error generando admin token LiveKit", e);
            throw new RuntimeException("Error creando admin token: " + e.getMessage(), e);
        }
    }

    private static String base64Url(byte[] data) {
        return Base64.encodeToString(data, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }
}
