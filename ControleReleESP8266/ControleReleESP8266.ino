#define ENABLE_USER_AUTH
#define ENABLE_DATABASE

#include <ESP8266WiFi.h>
#include <WiFiClientSecureBearSSL.h>
#include <FirebaseClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "FirebaseCA.h"
#include <coredecls.h>
#include <WiFiUdp.h>
#include <NTPClient.h>
#include <sys/time.h>

WiFiUDP ntpUDP;
NTPClient ntpClient(ntpUDP, "200.160.7.196", 0, 60000);

// ----- PREENCHA AQUI -----
#define WIFI_SSID "OJEDA"
#define WIFI_PASSWORD "mateus118"
#define API_KEY "AIzaSyADLSER8dTB8uALkNvFgGRgu-I8PfWeBYk"
#define USER_EMAIL "esp8266@example.com"
#define USER_PASSWORD "852130"
#define DATABASE_URL "https://controle-rele-default-rtdb.firebaseio.com/"
// -------------------------

#define RELAY_PIN 5             // GPIO5 / D1 (NodeMCU ou Wemos)
#define RELAY_ON LOW           // Modulo active LOW
#define RELAY_OFF HIGH

const uint32_t WIFI_RETRY_MS = 15000;
const uint32_t STATE_RETRY_MS = 3000;
const uint32_t STATE_TIMEOUT_MS = 20000;
const int64_t MAX_COMMAND_AGE_MS = 120000; // So liga se criado ha <= 2 min
const int64_t MAX_FUTURE_SKEW_MS = 15000;
const uint32_t HEARTBEAT_INTERVAL_MS = 15000;

void processData(AsyncResult &result);

BearSSL::X509List trustedCAs(FIREBASE_CA_CERTS);
BearSSL::WiFiClientSecure sslClient;
BearSSL::WiFiClientSecure streamSSLClient;
AsyncClientClass authClient(sslClient);
AsyncClientClass streamClient(streamSSLClient);
UserAuth userAuth(API_KEY, USER_EMAIL, USER_PASSWORD, 3000);
FirebaseApp app;
RealtimeDatabase database;

JsonDocument commandCache;
String lastSeenId = "";
String lastAppliedId = "initial";

bool firebaseStarted = false;
bool initialSnapshotReceived = false;
bool pendingCommand = false;
bool relayOn = false;
bool timerActive = false;
bool stateDirty = false;
bool stateWritePending = false;
bool lastWifiConnected = false;

uint32_t timerStartedAt = 0;
uint32_t remainingTimerMs = 0;
uint32_t lastWifiRetry = 0;
uint32_t lastStateAttempt = 0;
uint32_t stateWriteStarted = 0;
double expiresAt = 0;
uint32_t lastHeartbeatPublish = 0;

const char* ntpServers[] = {
  "200.160.7.196",
  "200.160.7.186",
  "time.google.com"
};

uint32_t ntpAttemptAt = 0;

bool ntpStarted = false;
bool ntpConfirmed = false;

bool syncNTP() {

  Serial.println("Sincronizando NTP...");

  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  const char* servers[] = {
    "200.160.7.196",
    "200.160.7.186",
    "time.google.com"
  };

  for (int i = 0; i < 3; i++) {

    Serial.print("NTP: ");
    Serial.println(servers[i]);

    ntpClient.setPoolServerName(servers[i]);

    if (!ntpClient.forceUpdate()) {
      continue;
    }

    time_t epoch = ntpClient.getEpochTime();

    if (epoch <= 1700000000) {
      continue;
    }

    struct timeval tv = {};
    tv.tv_sec = epoch;

    if (settimeofday(&tv, nullptr) != 0) {
      continue;
    }

    ntpConfirmed = true;

    Serial.printf(
      "NTP sincronizado! UTC epoch: %lu\n",
      (unsigned long)time(nullptr)
    );

    return true;
  }

  Serial.println("Falha em todos os servidores NTP.");
  return false;
}

void startNtp() {

  if (!ntpStarted) {
    ntpClient.begin();
    ntpStarted = true;
  }

  // Permite uma tentativa imediata.
  ntpAttemptAt = millis() - 15000UL;
}

void maintainNtp() {

  if (!ntpStarted || ntpConfirmed) {
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if ((uint32_t)(millis() - ntpAttemptAt) < 15000) {
    return;
  }

  ntpAttemptAt = millis();

  syncNTP();
}

uint64_t nowEpochMs() {
  return (uint64_t)time(nullptr) * 1000ULL;
}

bool clockReady() {
  return time(nullptr) > 1700000000;
}

void setRelay(bool enabled) {
  relayOn = enabled;
  digitalWrite(RELAY_PIN, enabled ? RELAY_ON : RELAY_OFF);
  Serial.println(enabled ? "RELE LIGADO" : "RELE DESLIGADO");
}

void markStateDirty() {
  stateDirty = true;
}

void checkTimer() {
  if (!timerActive) return;
  if ((uint32_t)(millis() - timerStartedAt) < remainingTimerMs) return;

  timerActive = false;
  expiresAt = 0;
  setRelay(false);
  markStateDirty();
  Serial.println("Temporizador finalizado!");
}

// So reconhecemos como comando novo um ID diferente.
// Ao iniciar, o primeiro snapshot e baseline: nao aciona o rele.
void checkForNewId() {
  if (!commandCache["id"].is<const char*>()) return;
  String id = commandCache["id"].as<String>();
  if (id.isEmpty()) return;

  if (!initialSnapshotReceived) {
    initialSnapshotReceived = true;
    lastSeenId = id;
    markStateDirty(); // Informa que reiniciamos com o rele desligado
    Serial.printf("Estado inicial ignorado: %s\n", id.c_str());
    return;
  }

  if (id != lastSeenId) {
    pendingCommand = true;
  }
}

void applyCommand() {
  pendingCommand = false;

  if (!commandCache["id"].is<const char*>() ||
      !commandCache["enabled"].is<bool>() ||
      !commandCache["durationMinutes"].is<int>()) {
    Serial.println("Comando incompleto/invalido; ignorado.");
    return;
  }

  const String id = commandCache["id"].as<String>();
  if (id.isEmpty() || id == lastSeenId) return;

  const bool enabled = commandCache["enabled"].as<bool>();
  const int minutes = commandCache["durationMinutes"].as<int>();
  const double createdAt = commandCache["createdAt"].as<double>();

  // O ID nunca e processado duas vezes, mesmo em reconexoes.
  lastSeenId = id;

  if (minutes < 0 || minutes > 1440) {
    Serial.println("Duracao fora do limite. Ignorado.");
    return;
  }

  // Desligar e sempre seguro, inclusive se o comando chegou atrasado.
  if (!enabled) {
    timerActive = false;
    expiresAt = 0;
    lastAppliedId = id;
    setRelay(false);
    markStateDirty();
    return;
  }

  // Para LIGAR e obrigatorio o timestamp valido do servidor.
  // Tambem evita executar um comando perdido na rede ha varios minutos.
  if (!clockReady() || createdAt < 1700000000000.0) {
    Serial.println("LIGAR rejeitado: relogio/timestamp invalidos.");
    return;
  }

  const int64_t ageMs = (int64_t)nowEpochMs() - (int64_t)createdAt;
  if (ageMs < -MAX_FUTURE_SKEW_MS || ageMs > MAX_COMMAND_AGE_MS) {
    Serial.printf("LIGAR rejeitado: comando atrasado/futuro (%lld ms).\n",
                  (long long)ageMs);
    return;
  }

  uint32_t duration = (uint32_t)minutes * 60000UL;
  if (minutes > 0 && ageMs >= (int64_t)duration) {
    Serial.println("LIGAR rejeitado: temporizador ja expirou.");
    return;
  }

  timerActive = false;
  expiresAt = 0;
  lastAppliedId = id;

  if (minutes > 0) {
    // Conta o tempo desde a EMISSAO do comando, nao desde a entrega.
    uint32_t elapsed = ageMs > 0 ? (uint32_t)ageMs : 0;
    remainingTimerMs = duration - elapsed;
    timerStartedAt = millis();
    timerActive = true;
    expiresAt = createdAt + (double)duration;
    Serial.printf("Temporizador: %lu ms restantes\n",
                  (unsigned long)remainingTimerMs);
  }

  setRelay(true);
  markStateDirty();
}

// Firebase REST SSE envia put (substituir) ou patch (mesclar).
void mergeRootPatch(const String &payload) {
  JsonDocument patch;
  if (deserializeJson(patch, payload)) return;
  JsonObjectConst values = patch.as<JsonObjectConst>();
  if (values.isNull()) return;

  for (JsonPairConst entry : values) {
    const char *key = entry.key().c_str();
    if (strcmp(key, "id") == 0 || strcmp(key, "enabled") == 0 ||
        strcmp(key, "durationMinutes") == 0 ||
        strcmp(key, "createdAt") == 0) {
      commandCache[key].set(entry.value());
    }
  }
}

void handleStreamData(const String &event, const String &path,
                      const String &payload) {
  if (event == "keep-alive") return;
  if (event == "cancel" || event == "auth_revoked") {
    Serial.printf("STREAM %s - conferir acesso/autenticacao.\n", event.c_str());
    return;
  }
  if (event != "put" && event != "patch") return;

  Serial.printf("Firebase: %s %s -> %s\n",
                event.c_str(), path.c_str(), payload.c_str());

  if (path == "/") {
    if (event == "put") {
      if (deserializeJson(commandCache, payload)) {
        Serial.println("Snapshot JSON invalido.");
        return;
      }
    } else {
      mergeRootPatch(payload);
    }
  } else if (path == "/id") {
    // Dependendo da versao, stream.to<char*>() retorna string sem aspas.
    String id = payload;
    id.trim();
    if (id.startsWith("\"")) {
      JsonDocument parsed;
      if (deserializeJson(parsed, id)) return;
      if (!parsed.is<const char*>()) return;
      id = parsed.as<String>();
    }
    commandCache["id"] = id;
  } else if (path == "/enabled" ||
             path == "/durationMinutes" ||
             path == "/createdAt") {
    JsonDocument parsed;
    if (deserializeJson(parsed, payload)) return;
    commandCache[path.substring(1)].set(parsed.as<JsonVariantConst>());
  } else {
    return;
  }

  checkForNewId();
}

void processData(AsyncResult &result) {
  const String task = result.uid();


  if (result.isDebug()) {
    Serial.printf(
      "Firebase [%s] DEBUG: %s\n",
      task.c_str(),
      result.debug().c_str()
    );
  }

  if (result.isEvent()) {
    Serial.printf(
      "Firebase [%s] EVENTO: %s\n",
      task.c_str(),
      result.eventLog().message().c_str()
    );
  }


  if (result.isError()) {
    Serial.printf("Firebase [%s] erro: %s (%d)\n",
                  task.c_str(), result.error().message().c_str(),
                  result.error().code());
    if (task == "stateWrite") {
      stateWritePending = false;
      markStateDirty();
    }
    return;
  }

  if (!result.available()) return;

  if (task == "stateWrite") {
    if (stateWritePending) {
      stateWritePending = false;
      Serial.println("Estado confirmado pelo Firebase.");
    }
    return;
  }

  if (task != "relayStream") return;

  RealtimeDatabaseResult &stream = result.to<RealtimeDatabaseResult>();
  if (stream.isStream()) {
    handleStreamData(stream.event(), stream.dataPath(),
                     stream.to<const char*>());
  }
}


void publishState() {
  JsonDocument state;

  state["enabled"] = relayOn;
  state["lastCommandId"] = lastSeenId;
  state["expiresAt"] = expiresAt;

  // O Firebase substitui pelo horario do servidor.
  state["lastSeenAt"][".sv"] = "timestamp";

  String json;
  serializeJson(state, json);

  Serial.printf(
    "Publicando: %s\n"
    "Heap livre: %u bytes\n",
    json.c_str(),
    ESP.getFreeHeap()
  );

  stateWritePending = true;
  stateWriteStarted = millis();
  stateDirty = false;
  lastHeartbeatPublish = millis();

  database.set<object_t>(
    authClient,
    "/relay/state",
    object_t(json.c_str()),
    processData,
    "stateWrite"
  );
}


void maintainWiFi() {
  const bool connected = WiFi.status() == WL_CONNECTED;

  if (connected != lastWifiConnected) {
    lastWifiConnected = connected;

    if (connected) {
      Serial.println("Wi-Fi conectado.");

      if (!firebaseStarted) {
        Serial.println("Iniciando sincronizacao NTP...");

        ntpConfirmed = false;
        startNtp();
      }
    } else {
      Serial.println("Wi-Fi desconectado.");
    }
  }

  if (!connected &&
      (uint32_t)(millis() - lastWifiRetry) >= WIFI_RETRY_MS) {
    lastWifiRetry = millis();
    Serial.println("Tentando reconectar Wi-Fi...");
    WiFi.reconnect();
  }
}


void startFirebase() {
  // NUNCA usar setInsecure() em producao.
  sslClient.setTrustAnchors(&trustedCAs);
  streamSSLClient.setTrustAnchors(&trustedCAs);
  sslClient.setBufferSizes(2048, 512);
  streamSSLClient.setBufferSizes(2048, 512);  

  initializeApp(authClient, app, getAuth(userAuth), processData, "authTask");
  app.getApp<RealtimeDatabase>(database);
  database.url(DATABASE_URL);

  streamClient.setSSEFilters("get,put,patch,keep-alive,cancel,auth_revoked");
  database.get(streamClient, "/relay/command", processData,
               true, "relayStream");

  firebaseStarted = true;
  Serial.println("Firebase iniciado com verificacao TLS ativada.");
}

void setup() {
  Serial.begin(115200);
  delay(300);

  digitalWrite(RELAY_PIN, RELAY_OFF);
  pinMode(RELAY_PIN, OUTPUT);
  Serial.println("\nESP8266: relé inicia DESLIGADO.");

  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void loop() {
  // Temporizador SEM depender da internet, sempre em primeiro lugar.
  checkTimer();
  maintainWiFi();
  maintainNtp();

  static bool ntpLogged = false;

  if (!ntpLogged && clockReady()) {
    ntpLogged = true;
    Serial.println("NTP sincronizado!");
  }

  if (!firebaseStarted &&
      WiFi.status() == WL_CONNECTED &&
      ntpConfirmed &&
      clockReady()) {
    startFirebase();
  }

  if (firebaseStarted) {
    // Mantem autenticacao, leitura SSE e tarefas assincronas.
    app.loop();
    database.loop();
  }

  if (pendingCommand) applyCommand();

  if (firebaseStarted &&
      initialSnapshotReceived &&
      WiFi.status() == WL_CONNECTED &&
      app.ready() &&
      (uint32_t)(millis() - lastHeartbeatPublish)
          >= HEARTBEAT_INTERVAL_MS) {

    markStateDirty();
  }

  if (stateWritePending &&
      (uint32_t)(millis() - stateWriteStarted) > STATE_TIMEOUT_MS) {
    Serial.println("Timeout ao publicar estado; tentarei novamente.");
    stateWritePending = false;
    markStateDirty();
  }

  if (firebaseStarted && WiFi.status() == WL_CONNECTED && app.ready() &&
      stateDirty && !stateWritePending &&
      (uint32_t)(millis() - lastStateAttempt) >= STATE_RETRY_MS) {
    lastStateAttempt = millis();
    publishState();
  }

  delay(1);
}
