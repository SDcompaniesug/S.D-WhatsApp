package com.sdcompanies.whatsapp;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private EditText phoneInput;
    private EditText codeInput;
    private TextView statusText;
    private Button requestButton;
    private Button verifyButton;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        phoneInput = findViewById(R.id.phoneInput);
        codeInput = findViewById(R.id.codeInput);
        statusText = findViewById(R.id.statusText);
        requestButton = findViewById(R.id.requestButton);
        verifyButton = findViewById(R.id.verifyButton);

        requestButton.setOnClickListener(v -> requestOtp());
        verifyButton.setOnClickListener(v -> verifyOtp());
    }

    private void requestOtp() {
        String phone = phoneInput.getText().toString().trim();
        if (!phone.matches("^\\+[1-9][0-9]{7,14}$")) {
            statusText.setText("Enter your number with country code, e.g. +256...");
            return;
        }
        setBusy(true, "Requesting verification code...");
        postJson("/api/v1/auth/request-otp", phone, null);
    }

    private void verifyOtp() {
        String phone = phoneInput.getText().toString().trim();
        String code = codeInput.getText().toString().trim();
        if (!phone.matches("^\\+[1-9][0-9]{7,14}$") || !code.matches("^[0-9]{4,10}$")) {
            statusText.setText("Enter a valid phone number and verification code.");
            return;
        }
        setBusy(true, "Verifying your number...");
        postJson("/api/v1/auth/verify-otp", phone, code);
    }

    private void postJson(String path, String phone, String code) {
        executor.execute(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL(BuildConfig.API_BASE_URL + path);
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");

                JSONObject body = new JSONObject();
                body.put("phone", phone);
                if (code != null) body.put("code", code);

                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(bytes);
                }

                int status = connection.getResponseCode();
                InputStream stream = status >= 200 && status < 300
                        ? connection.getInputStream() : connection.getErrorStream();
                StringBuilder response = new StringBuilder();
                if (stream != null) {
                    try (BufferedReader reader = new BufferedReader(
                            new InputStreamReader(stream, StandardCharsets.UTF_8))) {
                        String line;
                        while ((line = reader.readLine()) != null) response.append(line);
                    }
                }

                JSONObject result = new JSONObject(response.toString());
                String message;
                if (status >= 200 && status < 300) {
                    if (code == null) {
                        message = "Code sent. Check your SMS messages.";
                    } else {
                        message = "Phone verified. Account setup response received.";
                    }
                } else {
                    message = result.optString("error", "Request failed (" + status + ").");
                }
                showStatus(message);
            } catch (Exception error) {
                showStatus("Connection failed. Check the API URL and your internet connection.");
            } finally {
                if (connection != null) connection.disconnect();
                mainHandler.post(() -> setBusy(false, null));
            }
        });
    }

    private void setBusy(boolean busy, String message) {
        requestButton.setEnabled(!busy);
        verifyButton.setEnabled(!busy);
        if (message != null) statusText.setText(message);
    }

    private void showStatus(String message) {
        mainHandler.post(() -> statusText.setText(message));
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        executor.shutdownNow();
    }
}
