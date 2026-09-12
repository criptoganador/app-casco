package com.example.appcasco.util;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

/**
 * Gestor de geolocalización GPS en tiempo real para casco/celular.
 * Usa LocationManager estándar de Android sin dependencias de Google Play Services.
 */
public class LocationTracker {

    private static final String TAG = "LocationTracker";
    private static final long MIN_TIME_MS = 2000; // Actualizar cada 2 segundos
    private static final float MIN_DISTANCE_M = 1.0f; // o cada 1 metro

    public interface Callback {
        void onLocationUpdate(Location location);
    }

    private final Context context;
    private final Callback callback;
    private final LocationManager locationManager;
    private boolean isTracking = false;

    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(@NonNull Location location) {
            if (callback != null) {
                callback.onLocationUpdate(location);
            }
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override
        public void onProviderEnabled(@NonNull String provider) {
            Log.d(TAG, "Proveedor de ubicación habilitado: " + provider);
        }

        @Override
        public void onProviderDisabled(@NonNull String provider) {
            Log.w(TAG, "Proveedor de ubicación deshabilitado: " + provider);
        }
    };

    public LocationTracker(Context context, Callback callback) {
        this.context = context.getApplicationContext();
        this.callback = callback;
        this.locationManager = (LocationManager) this.context.getSystemService(Context.LOCATION_SERVICE);
    }

    public synchronized void start() {
        if (isTracking || locationManager == null) return;

        boolean hasFine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        boolean hasCoarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;

        if (!hasFine && !hasCoarse) {
            Log.w(TAG, "No hay permisos de ubicación concedidos para LocationTracker.");
            return;
        }

        isTracking = true;

        try {
            // Intentar obtener la última ubicación conocida de inmediato
            Location lastGps = locationManager.getLastKnownLocation(LocationManager.GPS_PROVIDER);
            Location lastNetwork = locationManager.getLastKnownLocation(LocationManager.NETWORK_PROVIDER);
            Location bestLast = lastGps != null ? lastGps : lastNetwork;
            if (bestLast != null && callback != null) {
                callback.onLocationUpdate(bestLast);
            }

            // Registrar escucha por GPS (satelital preciso)
            if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.GPS_PROVIDER,
                        MIN_TIME_MS,
                        MIN_DISTANCE_M,
                        locationListener,
                        Looper.getMainLooper()
                );
                Log.d(TAG, "Suscrito a actualizaciones de GPS_PROVIDER");
            }

            // Registrar escucha por RED / Celular / Wi-Fi (rápido para interiores)
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                        LocationManager.NETWORK_PROVIDER,
                        MIN_TIME_MS,
                        MIN_DISTANCE_M,
                        locationListener,
                        Looper.getMainLooper()
                );
                Log.d(TAG, "Suscrito a actualizaciones de NETWORK_PROVIDER");
            }

        } catch (SecurityException e) {
            Log.e(TAG, "Error de seguridad solicitando ubicaciones:", e);
            isTracking = false;
        } catch (Exception e) {
            Log.e(TAG, "Error iniciando LocationTracker:", e);
            isTracking = false;
        }
    }

    public synchronized void stop() {
        if (!isTracking || locationManager == null) return;
        try {
            locationManager.removeUpdates(locationListener);
            Log.d(TAG, "LocationTracker detenido.");
        } catch (Exception e) {
            Log.w(TAG, "Error deteniendo LocationTracker:", e);
        } finally {
            isTracking = false;
        }
    }

    public boolean isTracking() {
        return isTracking;
    }
}
