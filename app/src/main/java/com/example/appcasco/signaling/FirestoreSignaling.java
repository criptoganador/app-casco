package com.example.appcasco.signaling;

import android.content.Context;
import android.util.Log;

import com.google.android.gms.tasks.Task;
import com.google.android.gms.tasks.Tasks;
import com.google.firebase.FirebaseApp;
import com.google.firebase.firestore.CollectionReference;
import com.google.firebase.firestore.DocumentChange;
import com.google.firebase.firestore.DocumentReference;
import com.google.firebase.firestore.FieldValue;
import com.google.firebase.firestore.FirebaseFirestore;
import com.google.firebase.firestore.FirebaseFirestoreException;
import com.google.firebase.firestore.ListenerRegistration;
import com.google.firebase.firestore.SetOptions;
import com.google.firebase.firestore.DocumentSnapshot;
import com.google.firebase.firestore.QuerySnapshot;
import com.google.firebase.firestore.WriteBatch;

import org.webrtc.IceCandidate;
import org.webrtc.SessionDescription;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;

import javax.annotation.Nullable;

public class FirestoreSignaling {

    private static final String TAG = "FirestoreSignaling";

    public interface Listener {
        void onRemoteSdp(SessionDescription sdp);
        void onRemoteIce(IceCandidate c);
        void onError(String message, Exception e);
    }

    private final FirebaseFirestore db;
    private final DocumentReference roomDoc;
    private final CollectionReference callerCandCol;
    private final CollectionReference calleeCandCol;
    private final Listener listener;

    private ListenerRegistration answerReg;
    private ListenerRegistration remoteIceReg;

    public FirestoreSignaling(Context ctx, String roomId, Listener listener) {
        if (FirebaseApp.getApps(ctx).isEmpty()) FirebaseApp.initializeApp(ctx);
        this.db = FirebaseFirestore.getInstance();
        this.roomDoc = db.collection("rooms").document(roomId);
        this.callerCandCol = roomDoc.collection("candidates").document("caller").collection("ice_app_android");
        this.calleeCandCol = roomDoc.collection("candidates").document("callee").collection("ice_app_pc");
        this.listener = listener;
    }

    public void postLocalSdp(SessionDescription sdp) {
        Map<String, Object> offerMap = new HashMap<>();
        offerMap.put("type", sdp.type.canonicalForm());
        offerMap.put("sdp", sdp.description);

        Map<String, Object> update = new HashMap<>();
        update.put("offer", offerMap);

        if (sdp.type == SessionDescription.Type.OFFER) {
            update.put("status", "pending");
            update.put("createdAt", FieldValue.serverTimestamp());
        }

        roomDoc.set(update, SetOptions.merge())
                .addOnFailureListener(e -> {
                    Log.e(TAG, "Fallo al publicar SDP: " + e.getMessage());
                    listener.onError("Fallo al publicar SDP", e);
                });
    }
    
    public void updateRoomStatus(String status) {
        roomDoc.update("status", status).addOnFailureListener(e -> {
            Log.w(TAG, "Failed to update room status", e);
        });
    }

    public void postIce(IceCandidate c, String who) {
        Map<String, Object> map = new HashMap<>();
        map.put("sdpMid", c.sdpMid);
        map.put("sdpMLineIndex", c.sdpMLineIndex);
        map.put("candidate", c.sdp);

        CollectionReference targetCol = "caller".equals(who) ? callerCandCol : calleeCandCol;

        targetCol.add(map)
                .addOnFailureListener(e -> {
                    Log.e(TAG, "Fallo al publicar ICE: " + e.getMessage());
                    listener.onError("Fallo al publicar ICE", e);
                });
    }

    public void listenForAnswer() {
        answerReg = roomDoc.addSnapshotListener((@Nullable DocumentSnapshot snap, @Nullable FirebaseFirestoreException e) -> {
            if (e != null) {
                Log.e(TAG, "Error escuchando ANSWER: " + e.getMessage());
                listener.onError("Error escuchando ANSWER", e);
                return;
            }
            if (snap == null || !snap.exists()) return;

            Object answerObject = snap.get("answer");
            if (!(answerObject instanceof Map)) {
                return;
            }
            
            @SuppressWarnings("unchecked")
            Map<String, Object> answer = (Map<String, Object>) answerObject;

            Object sdpStr = answer.get("sdp");
            Object typeStr = answer.get("type");

            if (sdpStr instanceof String && SessionDescription.Type.ANSWER.canonicalForm().equals(typeStr)) {
                listener.onRemoteSdp(new SessionDescription(SessionDescription.Type.ANSWER, (String) sdpStr));
            }
        });
    }

    public void listenForRemoteIce(String remoteWho) {
        CollectionReference remoteCol = "callee".equals(remoteWho) ? calleeCandCol : callerCandCol;

        remoteIceReg = remoteCol.addSnapshotListener((@Nullable QuerySnapshot qs, @Nullable FirebaseFirestoreException e) -> {
            if (e != null) {
                Log.e(TAG, "Error escuchando ICE remoto: " + e.getMessage());
                listener.onError("Error escuchando ICE remoto", e);
                return;
            }
            if (qs == null) return;

            for (DocumentChange dc : qs.getDocumentChanges()) {
                if (dc.getType() != DocumentChange.Type.ADDED) continue;

                Map<String, Object> m = dc.getDocument().getData();

                try {
                    String mid = Objects.requireNonNull(m.get("sdpMid")).toString();
                    Long idxLong = (Long) m.get("sdpMLineIndex");
                    int idx = (idxLong != null) ? idxLong.intValue() : 0;
                    String cand = Objects.requireNonNull(m.get("candidate")).toString();
                    listener.onRemoteIce(new IceCandidate(mid, idx, cand));

                } catch (Exception conversionError) {
                    Log.e(TAG, "Error al parsear ICE Candidate: " + conversionError.getMessage());
                    listener.onError("Error al parsear ICE Candidate", conversionError);
                }
            }
        });
    }

    public Task<Void> clearRoom() {
        Task<QuerySnapshot> callerTask = callerCandCol.get();
        Task<QuerySnapshot> calleeTask = calleeCandCol.get();

        return Tasks.whenAllSuccess(callerTask, calleeTask)
            .onSuccessTask(results -> {
                WriteBatch batch = db.batch();
                for (Object result : results) {
                    QuerySnapshot qs = (QuerySnapshot) result;
                    for (DocumentSnapshot doc : qs.getDocuments()) {
                        batch.delete(doc.getReference());
                    }
                }
                batch.delete(roomDoc);
                return batch.commit();
            });
    }

    public void dispose() {
        if (answerReg != null) {
            answerReg.remove();
            answerReg = null;
        }
        if (remoteIceReg != null) {
            remoteIceReg.remove();
            remoteIceReg = null;
        }
    }
}
