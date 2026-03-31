/**
 * Miniature Dozer Rental — ESP32 Control Firmware
 *
 * Wiring:
 *   RELAY_PIN (GPIO 26)   → Relay module IN pin
 *   VOLTAGE_PIN (GPIO 34) → Voltage sensor analog output
 *   ESTOP_PIN (GPIO 27)   → Emergency stop button (NC to GND, pull-up)
 *
 * Setup per unit before flashing:
 *   - Set DEVICE_ID to a unique value e.g. "dozer_01"
 *   - Set DEVICE_SECRET to match the secret registered in the server DB
 *   - Set WIFI_SSID / WIFI_PASSWORD for the site network
 *   - Set SERVER_URL to your backend address
 */

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------------------
// CONFIG — edit these per unit before flashing
// ---------------------------------------------------------------------------
const char* DEVICE_ID     = "dozer_01";
const char* DEVICE_SECRET = "REPLACE_WITH_DEVICE_SECRET";
const char* WIFI_SSID     = "REPLACE_WITH_WIFI_SSID";
const char* WIFI_PASSWORD = "REPLACE_WITH_WIFI_PASSWORD";
const char* SERVER_URL    = "http://192.168.1.100:3000";  // replace with your server IP/domain

// ---------------------------------------------------------------------------
// PIN CONFIG
// ---------------------------------------------------------------------------
const int RELAY_PIN   = 26;  // HIGH = relay ON (dozer powered)
const int VOLTAGE_PIN = 34;  // Analog input from voltage sensor
const int ESTOP_PIN   = 27;  // Emergency stop button (pull-up, NC)

// ---------------------------------------------------------------------------
// BATTERY CONFIG (12V lead-acid)
// ---------------------------------------------------------------------------
const float BATTERY_MAX_V = 12.6;
const float BATTERY_MIN_V = 10.5;
// Voltage divider ratio — 0-25V sensor maps ~25V to 3.3V (ESP32 ADC max)
// Adjust to match your specific voltage sensor module
const float VOLTAGE_DIVIDER_RATIO = 25.0 / 3.3;
const int   ADC_MAX               = 4095;  // ESP32 12-bit ADC

// ---------------------------------------------------------------------------
// TIMING
// ---------------------------------------------------------------------------
const unsigned long POLL_INTERVAL_MS = 5000;  // poll server every 5 seconds

// ---------------------------------------------------------------------------
// STATE
// ---------------------------------------------------------------------------
volatile bool estopPressed = false;
bool relayState = false;
unsigned long lastPollTime = 0;

// ---------------------------------------------------------------------------
// ESTOP interrupt — fires immediately when button is pressed
// ---------------------------------------------------------------------------
void IRAM_ATTR onEstopPressed() {
  estopPressed = true;
}

// ---------------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------------
void setup() {
  Serial.begin(115200);

  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);  // relay OFF on boot

  pinMode(ESTOP_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ESTOP_PIN), onEstopPressed, FALLING);

  connectWiFi();
}

// ---------------------------------------------------------------------------
// MAIN LOOP
// ---------------------------------------------------------------------------
void loop() {
  // Re-connect WiFi if dropped
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] Disconnected — reconnecting...");
    connectWiFi();
  }

  // Handle emergency stop immediately (interrupt flag)
  if (estopPressed) {
    estopPressed = false;
    Serial.println("[estop] Emergency stop triggered!");
    setRelay(false);
    notifyEstop();
    return;
  }

  // Poll server on interval
  if (millis() - lastPollTime >= POLL_INTERVAL_MS) {
    lastPollTime = millis();
    pollServer();
    sendHeartbeat();
  }
}

// ---------------------------------------------------------------------------
// Connect to WiFi
// ---------------------------------------------------------------------------
void connectWiFi() {
  Serial.printf("[wifi] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[wifi] Connected. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[wifi] Failed to connect — will retry on next loop");
  }
}

// ---------------------------------------------------------------------------
// Poll server for relay command
// GET /device/poll?device_id=<id>&key=<secret>
// Response: { command: "ON"|"OFF"|"NONE", seconds_remaining: 300 }
// ---------------------------------------------------------------------------
void pollServer() {
  HTTPClient http;
  String url = String(SERVER_URL) + "/device/poll?device_id=" + DEVICE_ID + "&key=" + DEVICE_SECRET;

  http.begin(url);
  int code = http.GET();

  if (code == 200) {
    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, http.getString());

    if (!err) {
      const char* command = doc["command"];
      int secondsRemaining = doc["seconds_remaining"] | 0;

      Serial.printf("[poll] Command: %s | Time left: %ds\n", command, secondsRemaining);

      if (strcmp(command, "ON") == 0) {
        setRelay(true);
      } else if (strcmp(command, "OFF") == 0) {
        setRelay(false);
      }
    }
  } else {
    Serial.printf("[poll] Server error: %d\n", code);
  }

  http.end();
}

// ---------------------------------------------------------------------------
// Send heartbeat to server
// POST /device/heartbeat?device_id=<id>&key=<secret>
// Body: { battery_pct, relay_state }
// ---------------------------------------------------------------------------
void sendHeartbeat() {
  float batteryPct = readBatteryPercent();

  HTTPClient http;
  String url = String(SERVER_URL) + "/device/heartbeat?device_id=" + DEVICE_ID + "&key=" + DEVICE_SECRET;

  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  StaticJsonDocument<128> doc;
  doc["battery_pct"] = batteryPct;
  doc["relay_state"] = relayState ? 1 : 0;

  String body;
  serializeJson(doc, body);

  int code = http.POST(body);
  if (code != 200) {
    Serial.printf("[heartbeat] Failed: %d\n", code);
  }

  http.end();
}

// ---------------------------------------------------------------------------
// Notify server of emergency stop
// POST /device/estop?device_id=<id>&key=<secret>
// ---------------------------------------------------------------------------
void notifyEstop() {
  HTTPClient http;
  String url = String(SERVER_URL) + "/device/estop?device_id=" + DEVICE_ID + "&key=" + DEVICE_SECRET;

  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST("{}");

  if (code == 200) {
    Serial.println("[estop] Server notified");
  } else {
    Serial.printf("[estop] Server notification failed: %d\n", code);
  }

  http.end();
}

// ---------------------------------------------------------------------------
// Set relay state
// ---------------------------------------------------------------------------
void setRelay(bool on) {
  relayState = on;
  digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  Serial.printf("[relay] %s\n", on ? "ON" : "OFF");
}

// ---------------------------------------------------------------------------
// Read battery percentage from voltage sensor
// ---------------------------------------------------------------------------
float readBatteryPercent() {
  int raw = analogRead(VOLTAGE_PIN);
  // Convert ADC reading to actual voltage
  float voltage = (raw / (float)ADC_MAX) * 3.3 * VOLTAGE_DIVIDER_RATIO;
  // Clamp to known range and convert to percentage
  voltage = constrain(voltage, BATTERY_MIN_V, BATTERY_MAX_V);
  float pct = ((voltage - BATTERY_MIN_V) / (BATTERY_MAX_V - BATTERY_MIN_V)) * 100.0;
  Serial.printf("[battery] %.2fV = %.1f%%\n", voltage, pct);
  return pct;
}
