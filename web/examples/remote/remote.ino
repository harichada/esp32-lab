// ESP32 Wi-Fi remote: Sony Bravia (IRCC-IP + JSON-RPC) and Roku (ECP)
// Sketches can reach the simulated devices in Circuit Lab, but not the internet, which is blocked for safety. Requests to real websites will fail even if your code is fine.
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiUdp.h>
#include "esp_sleep.h"
#include "driver/gpio.h"
#include "remote_logic.h"   // pure key->command logic (shared with native tests)
struct KabCred { bool valid; uint32_t idInt, m; char key[13], pass[33]; uint16_t port; int power; };

// ---------------- CONFIG ----------------
#ifdef SIM   // Simulator build: open guest Wi-Fi, configurable targets (host[:port])
#ifndef SIM_SONY_HOST
#define SIM_SONY_HOST "host.sim.internal:8080"   // simulator private gateway -> your PC; or any public host
#endif
#ifndef SIM_ROKU_HOST
#define SIM_ROKU_HOST "host.sim.internal"
#endif
#ifndef SIM_ROKU_PORT
#define SIM_ROKU_PORT "8060"
#endif
#ifndef SIM_ECO_HOST
#define SIM_ECO_HOST "10.13.37.2"
#endif
const char* WIFI_SSID = "SIM-GUEST";
const char* WIFI_PASS = "";
const char* SONY_IP   = SIM_SONY_HOST;
#else
const char* WIFI_SSID = "YOUR_SSID";
const char* WIFI_PASS = "YOUR_PASSWORD";
const char* SONY_IP   = "192.168.1.50";
#endif
const char* SONY_PSK  = "0000";              // TV: Network > IP control > Pre-Shared Key
const char* SONY_MAC  = "";                  // e.g. "AA:BB:CC:DD:EE:FF" to enable Wake-on-LAN
#ifdef SIM
const char* ROKU_IP   = SIM_ROKU_HOST;
const char* ROKU_PORT = SIM_ROKU_PORT;
const char* ECO_IPS[] = { SIM_ECO_HOST };
#else
const char* ROKU_IP   = "192.168.1.60";
const char* ROKU_PORT = "8060";

// Eco Plugs (KAB / Woods WiOn, legacy "FtNetManager" UDP protocol). Give the plug a DHCP reservation.
const char* ECO_IPS[] = { "192.168.1.70" };      // add more IPs to toggle several plugs together
#endif
const char* ECO_IDS[] = { "ECO-12345678" };      // "ECO-" + last 4 MAC bytes, UPPERCASE hex (shown by discovery)
const uint16_t ECO_PORT = 80;                    // legacy command port (UDP)
// Protocol per plug: false = legacy (UDP 80), true = newer encrypted KAB firmware (e.g. TM-050B; UDP 1022, beacons on 10228).
// For KAB plugs the ID is ignored; credentials are learned from the plug's beacon. Boot discovery prints which one each plug is.
const bool ECO_KAB[] = { true };
#ifdef SIM
const bool ECO_DISCOVER_AT_BOOT = false;
#else
const bool ECO_DISCOVER_AT_BOOT = true;
#endif
//         // broadcast to UDP 25/5888, print replies (IP + ID) on Serial
// ----------------------------------------

const uint8_t ROWS[4] = {13, 14, 27, 26};      // outputs (driven LOW to scan)
const uint8_t COLS[5] = {25, 33, 32, 19, 18};  // inputs, pull-up
const uint8_t LED_PIN = 2;                     // status / mode LED (ON = Roku mode)
const uint8_t VBAT_PIN = 35;                   // optional 100k/100k divider
const uint8_t IR_PIN = 4;                      // IR LED driver (2N2222 base via 1k, 10k pull-down). HIGH = LED on
// IR_FALLBACK (remote_logic.h): 0 = IR for power only (default); build with -DIR_FALLBACK=1 to also send vol/mute/input by IR.

// Btn enum + KEYMAP live in remote_logic.h

bool rokuMode = false;
const uint32_t DEBOUNCE_MS = 30;
bool stable[4][5], lastRaw[4][5];
uint32_t changedAt[4][5];
uint32_t lastActivity = 0;

void ledUpdate() { digitalWrite(LED_PIN, rokuMode ? HIGH : LOW); }
void blink() { digitalWrite(LED_PIN, !rokuMode); delay(40); ledUpdate(); }

bool ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.printf("[net] WiFi connecting to \"%s\"...\n", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 8000) delay(50);
  if (WiFi.status() == WL_CONNECTED) Serial.printf("[net] WiFi connected, IP %s (%lu ms)\n", WiFi.localIP().toString().c_str(), (unsigned long)(millis() - t));
  else Serial.printf("[net] WiFi connect FAILED (status %d) - check SSID/password\n", (int)WiFi.status());
  return WiFi.status() == WL_CONNECTED;
}

int post(const String& url, const String& ctype, const String& body, bool sony, const char* soapAction = nullptr) {
  if (!ensureWiFi()) { Serial.printf("[net] POST %s skipped: no WiFi\n", url.c_str()); return -1; }
  uint32_t t0 = millis();
  HTTPClient http;
  http.setTimeout(3000);
  http.begin(url);
  if (ctype.length()) http.addHeader("Content-Type", ctype);
  if (sony) http.addHeader("X-Auth-PSK", SONY_PSK);
  if (soapAction) http.addHeader("SOAPACTION", soapAction);
  int code = body.length() ? http.POST(body) : http.POST((uint8_t*)nullptr, 0);
  http.end();
  Serial.printf("POST %s -> %d\n", url.c_str(), code);
  if (code < 0) Serial.printf("[net] POST %s failed: %s (%lu ms) - device unreachable? check IP/port\n", url.c_str(), HTTPClient::errorToString(code).c_str(), (unsigned long)(millis() - t0));
  else if (code == 403) Serial.printf("[net] POST %s -> 403: Sony PSK mismatch (TV: Network > IP control > Pre-Shared Key)\n", url.c_str());
  else Serial.printf("[net] POST %s -> %d (%lu ms)\n", url.c_str(), code, (unsigned long)(millis() - t0));
  return code;
}

void sonyIRCC(const char* code) {
  post(String("http://") + SONY_IP + "/sony/IRCC", SONY_IRCC_CTYPE, String(sonyIrccBody(code).c_str()), true, SONY_IRCC_SOAPACTION);
}

void sendWoL() {
  if (strlen(SONY_MAC) != 17 || !ensureWiFi()) return;
  uint8_t mac[6];
  if (sscanf(SONY_MAC, "%hhx:%hhx:%hhx:%hhx:%hhx:%hhx", &mac[0],&mac[1],&mac[2],&mac[3],&mac[4],&mac[5]) != 6) return;
  uint8_t pkt[102]; memset(pkt, 0xFF, 6);
  for (int i = 1; i <= 16; i++) memcpy(pkt + i*6, mac, 6);
  WiFiUDP udp;
  for (int n = 0; n < 3; n++) { udp.beginPacket(IPAddress(255,255,255,255), 9); udp.write(pkt, sizeof pkt); udp.endPacket(); delay(20); }
}

// ---------- IR (Sony SIRC 12-bit, 40 kHz, via ESP32 RMT; encoder = sircEncodeFrame in remote_logic.h) ----------
bool irReady = false;
void irBegin() {
  irReady = rmtInit(IR_PIN, RMT_TX_MODE, RMT_MEM_NUM_BLOCKS_1, 1000000)          // 1 tick = 1 us
         && rmtSetCarrier(IR_PIN, true, 0, SIRC_CARRIER_HZ, 0.33);              // 40 kHz, 33% duty, idle LOW
  Serial.printf("IR on GPIO%d: %s\n", IR_PIN, irReady ? "ready" : "RMT init FAILED");
}
void irSend(uint16_t code) {
  if (!irReady || !code) return;
  uint16_t mark[21]; uint32_t space[21];
  int n = sircEncodeFrame(code, 12, mark, space);
  rmt_data_t sym[21];
  for (int i = 0; i < n; i++) {
    uint32_t sp = space[i] > 32767 ? 32767 : space[i];   // RMT duration field is 15 bits
    sym[i].level0 = 1; sym[i].duration0 = mark[i]; sym[i].level1 = 0; sym[i].duration1 = sp;
  }
  uint32_t gap = space[n - 1] > 32767 ? space[n - 1] - 32767 : 0;
  for (int k = 0; k < SIRC_REPEATS; k++) {
    rmtWrite(IR_PIN, sym, n, RMT_WAIT_FOR_EVER);
    if (gap) delayMicroseconds(gap);                       // completes 45 ms start-to-start
  }
  Serial.printf("IR SIRC 0x%03X x%d\n", code, SIRC_REPEATS);
}

void sonyPower(bool on) {
  irSend(on ? SIRC_POWER_ON : SIRC_POWER_OFF);   // IR first: works even when TV is fully off (no network standby)
  if (on) sendWoL();
  post(String("http://") + SONY_IP + "/sony/system", "application/json", String(sonyPowerBody(on).c_str()), true);
}

void roku(const char* key) {
  post(String("http://") + ROKU_IP + ":" + ROKU_PORT + "/keypress/" + key, "", "", false);
}

void ecoToggle();
void handle(Btn b) {
  blink();
  Cmd c = keyCommand(b, rokuMode);
  switch (c.kind) {
    case C_SONY_POWER: sonyPower(c.on); break;
    case C_SONY_IRCC:  if (IR_FALLBACK) irSend(irCodeFor(b)); sonyIRCC(c.arg); break;
    case C_ROKU:       roku(c.arg); break;
    case C_ECO:        ecoToggle(); return;
    case C_MODE:       rokuMode = !rokuMode; ledUpdate(); Serial.printf("Mode: %s\n", rokuMode ? "Roku" : "TV"); break;
    default: break;
  }
}

// ---------- Eco Plugs (legacy UDP; ref. philburr/pyecoplug plug.py, gcd.org/blog/2019/11/1340) ----------
// 128-byte header (LE): [0..1] flags 0x16=write 0x17=read, [2..5] cmd=5, [6..7] xid, [8..9] payload len,
// [16..47] ID "ECO-XXXXXXXX", [116..119] time, [124..127] magic; payload @128: {0x01, state} for write.
const int ECO_N = sizeof(ECO_IPS) / sizeof(ECO_IPS[0]);
bool ecoState = false;           // last known state (refreshed by query before toggling)
WiFiUDP ecoUdp;

int ecoTxn(int i, bool write, bool on) {   // returns state 0/1, or -1 on no reply
  uint8_t pkt[130];
  size_t len = ecoLegacyPacket(pkt, ECO_IDS[i], write, on, (uint16_t)esp_random(), millis());
  ecoUdp.begin(0);
  for (int tries = 0; tries < 3; tries++) {
    ecoUdp.beginPacket(ECO_IPS[i], ECO_PORT); ecoUdp.write(pkt, len); ecoUdp.endPacket();
    uint32_t t0 = millis();
    while (millis() - t0 < 300) {
      int n = ecoUdp.parsePacket();
      if (n >= 128) {
        uint8_t r[200]; n = ecoUdp.read(r, sizeof(r));
        if (r[6] == pkt[6] && r[7] == pkt[7]) {
          ecoUdp.stop();
          if (n >= 130) return r[129] ? 1 : 0;
          return write ? (on ? 1 : 0) : -1;
        }
      }
      delay(5);
    }
  }
  ecoUdp.stop();
  return -1;
}

// ---------- Eco Plugs KAB (ports of dmaidlow/ha-ecoplug kab.py + kunalkhosla/ecoplug-homeassistant protocol.py) ----------
KabCred kabCred[sizeof(ECO_IPS) / sizeof(ECO_IPS[0])];
static uint32_t le32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static void put32(uint8_t* p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static void cstrcpy(char* dst, const uint8_t* src, int n) { int i = 0; for (; i < n && src[i]; i++) dst[i] = src[i]; dst[i] = 0; }

// Decrypt + validate a 272-byte beacon in place. Returns true if checksum OK.
bool kabDecrypt(uint8_t* d, int len) {
  if (len < 272) return false;
  uint8_t k0 = d[236], k1 = d[237], k2 = d[238], k3 = d[239], cl = 0, al = 0, bpl = 0;
  for (int rdx = 0; rdx < 248; rdx += 4) {
    int b = rdx + 20;
    if (rdx != 0xD8) { d[b] ^= cl ^ k0; d[b+1] ^= (uint8_t)rdx ^ k1; d[b+2] ^= al ^ k2; d[b+3] ^= bpl ^ k3; }
    cl += 2; al += 3; bpl += 1;
  }
  if (!(d[5] == 0x55 && d[6] == 0xAA && d[7] == 0x55 && d[8] == 0xAA)) return false;
  uint32_t sum = 0; for (int i = 20; i < 268; i++) sum += d[i];
  return sum == le32(d + 268);
}

// Listen on UDP 10228 up to ms; fill kabCred for matching plug IPs (or print all if wantIdx<0). Returns true if wantIdx got a beacon.
bool kabListen(uint32_t ms, int wantIdx) {
  WiFiUDP u; if (!u.begin(10228)) { Serial.println("KAB: bind 10228 failed"); return false; }
  uint32_t t0 = millis(); bool got = false; static uint8_t r[400];
  while (millis() - t0 < ms) {
    int n = u.parsePacket();
    if (n > 0) {
      n = u.read(r, sizeof(r)); IPAddress src = u.remoteIP();
      bool ok = kabDecrypt(r, n);
      char id[17]; cstrcpy(id, r + 44, 16);
      if (wantIdx < 0) Serial.printf("KAB beacon from %s len=%d id=%s checksum=%s power=%u\n", src.toString().c_str(), n, id, ok ? "OK" : "BAD", ok ? le32(r + 240) : 0);
      if (ok) for (int i = 0; i < (int)(sizeof(ECO_IPS) / sizeof(ECO_IPS[0])); i++) if (src.toString() == ECO_IPS[i]) {
        KabCred& c = kabCred[i]; c.valid = true; c.idInt = le32(r + 36); c.m = le32(r + 264);
        uint32_t p = le32(r + 76); c.port = (p > 0 && p < 65536) ? p : 1022; c.power = le32(r + 240) ? 1 : 0;
        cstrcpy(c.key, r + 152, 12); cstrcpy(c.pass, r + 164, 32);
        if (i == wantIdx) got = true;
      }
      if (got) break;
    }
    delay(5);
  }
  u.stop(); return got;
}

// Credentialed set (dmaidlow build_command, cmd 23 subtype 106).
void kabBuildCred(uint8_t* b, const KabCred& c, bool on) {
  memset(b, 0, 152);
  uint32_t seed = esp_random(); put32(b, seed); put32(b + 4, 23); put32(b + 12, c.idInt);
  memcpy(b + 16, c.key, strlen(c.key)); memcpy(b + 36, c.pass, strlen(c.pass));
  put32(b + 64, c.m); put32(b + 68, 0x12345678);
  uint8_t c0 = 0, c1 = 0, c2 = 0, c3 = 0;
  for (int i = 0; i < 14; i++) { int o = 16 + i * 4; b[o] ^= c0 ^ b[0]; b[o+1] ^= c1 ^ b[1]; b[o+2] ^= c2 ^ b[2]; b[o+3] ^= c3 ^ b[3]; c0 += 9; c1 += 13; c2 += 17; c3 += 19; }
  put32(b + 76, 106); put32(b + 80, on ? 1 : 0);
}
// Fixed-body set (kunalkhosla craft_command: body XOR txid, opcode 0x6A @76, state @80).
void kabBuildFixed(uint8_t* b, bool on) { kabBuildFixed(b, on, esp_random()); }  // pure version in remote_logic.h
int kabSend(int i, bool on) {   // returns 1 if plug replied
  uint8_t pkt[152];
  if (kabCred[i].valid) kabBuildCred(pkt, kabCred[i], on); else kabBuildFixed(pkt, on);
  uint16_t port = kabCred[i].valid ? kabCred[i].port : 1022;
  WiFiUDP u; if (!u.begin(9090)) u.begin(0);
  for (int k = 0; k < 4; k++) { u.beginPacket(ECO_IPS[i], port); u.write(pkt, 152); u.endPacket(); delay(10); }
  uint32_t t0 = millis(); int got = 0;
  while (millis() - t0 < 800) { int n = u.parsePacket(); if (n > 0) { uint8_t r[200]; u.read(r, sizeof r); if (u.remoteIP().toString() == ECO_IPS[i]) { got = 1; break; } } delay(5); }
  u.stop();
  Serial.printf("KAB %s set %s via %s -> %s\n", ECO_IPS[i], on ? "ON" : "OFF", kabCred[i].valid ? "cred" : "fixed", got ? "reply" : "no reply");
  return got;
}

void ecoToggle() {
  if (!ensureWiFi()) { for (int k = 0; k < 4; k++) { blink(); delay(60); } return; }
  int cur = -1;
  if (ECO_KAB[0]) { if (kabListen(2500, 0)) cur = kabCred[0].power; }   // state is read passively from beacons
  else cur = ecoTxn(0, false, false);              // query first plug's real state
  if (cur >= 0) ecoState = cur;
  bool target = !ecoState;
  bool ok = true;
  for (int i = 0; i < ECO_N; i++) {
    if (ECO_KAB[i] && i > 0 && !kabCred[i].valid) kabListen(2500, i);
    int r = ECO_KAB[i] ? kabSend(i, target) : ecoTxn(i, true, target);
    Serial.printf("Eco %s -> %s : %s\n", ECO_IPS[i], target ? "ON" : "OFF", r < 0 ? "no reply" : "sent");
    if (r < 0) Serial.printf("[net] Eco plug %s: no UDP reply - wrong IP, plug offline, or protocol (ECO_KAB) mismatch\n", ECO_IPS[i]);
    if (r < 0) ok = false;
  }
  ecoState = target;                               // optimistic if no reply
  blink(); if (target) { delay(120); blink(); }    // 2 blinks = ON, 1 = OFF
  if (!ok) { for (int k = 0; k < 4; k++) { delay(60); blink(); } }  // rapid = no reply
}

void ecoDiscover() {   // legacy discovery: broadcast read request, replies carry ID at [16..47], name at [48..79]
  WiFiUDP u; u.begin(8900);
  uint8_t pkt[128] = {0}; pkt[0] = 0x17; pkt[2] = 0x05;
  const uint16_t ports[2] = {25, 5888};
  for (auto p : ports) { u.beginPacket(IPAddress(255,255,255,255), p); u.write(pkt, 128); u.endPacket(); }
  uint32_t t0 = millis();
  while (millis() - t0 < 1500) {
    int n = u.parsePacket();
    if (n >= 80) {
      uint8_t r[400]; u.read(r, sizeof(r)); r[47] = 0; r[79] = 0;
      Serial.printf("EcoPlug found: %s  ID=%s  name=%s\n", u.remoteIP().toString().c_str(), (char*)r + 16, (char*)r + 48);
    }
    delay(5);
  }
  u.stop();
}

void idleRows() { for (auto r : ROWS) digitalWrite(r, LOW); }  // all rows low => any press pulls a column low

void scan() {
  for (int r = 0; r < 4; r++) {
    for (auto rr : ROWS) digitalWrite(rr, HIGH);
    digitalWrite(ROWS[r], LOW);
    delayMicroseconds(10);
    for (int c = 0; c < 5; c++) {
      bool pressed = digitalRead(COLS[c]) == LOW;
      if (pressed != lastRaw[r][c]) { lastRaw[r][c] = pressed; changedAt[r][c] = millis(); }
      if (pressed != stable[r][c] && millis() - changedAt[r][c] >= DEBOUNCE_MS) {
        stable[r][c] = pressed;
        if (pressed && KEYMAP[r][c] != B_NONE) { lastActivity = millis(); handle(KEYMAP[r][c]); }
      }
      if (pressed) lastActivity = millis();
    }
  }
  idleRows();
}

void lightSleep() {
  idleRows();
  for (auto c : COLS) gpio_wakeup_enable((gpio_num_t)c, GPIO_INTR_LOW_LEVEL);
  esp_sleep_enable_gpio_wakeup();
  esp_sleep_enable_timer_wakeup(30ULL * 1000000ULL);  // periodic wake keeps Wi-Fi association alive
  gpio_hold_en((gpio_num_t)LED_PIN);
  esp_light_sleep_start();
  gpio_hold_dis((gpio_num_t)LED_PIN);
  for (auto c : COLS) gpio_wakeup_disable((gpio_num_t)c);
  lastActivity = millis();
}

void setup() {
  Serial.begin(115200);
  for (auto r : ROWS) { pinMode(r, OUTPUT); digitalWrite(r, HIGH); }
  for (auto c : COLS) pinMode(c, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT); ledUpdate();
  irBegin();
  analogSetPinAttenuation(VBAT_PIN, ADC_11db);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(true);  // modem sleep
  ensureWiFi();
  if (ECO_DISCOVER_AT_BOOT && WiFi.status() == WL_CONNECTED) { ecoDiscover(); kabListen(6000, -1); }
  Serial.printf("[net] targets: Sony %s (PSK set: %s), Roku %s:%s, Eco %s\n", SONY_IP, strlen(SONY_PSK) ? "yes" : "no", ROKU_IP, ROKU_PORT, ECO_IPS[0]);
  Serial.printf("VBAT ~ %.2f V\n", analogReadMilliVolts(VBAT_PIN) * 2 / 1000.0);
}

void loop() {
  scan();
  delay(2);
#ifndef SIM
  if (millis() - lastActivity > 3000) lightSleep();  // (disabled in SIM build)
#endif  // idle 3 s -> light sleep until a key is pressed
}
