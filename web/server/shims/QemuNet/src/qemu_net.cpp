#include "WiFi.h"
#include "HTTPClient.h"
QemuWiFiClass WiFi;
namespace qemunet {
static String rxbuf;
void sendLine(const String& json) { Serial.flush(); Serial.print("\n@NET "); Serial.println(json); Serial.flush(); }
String jsonEsc(const String& s) {
  String o; o.reserve(s.length() + 8);
  for (size_t i = 0; i < s.length(); i++) { char c = s[i];
    if (c == '"' || c == '\\') { o += '\\'; o += c; } else if (c == '\n') o += "\\n"; else if ((uint8_t)c < 0x20) { char b[8]; snprintf(b, 8, "\\u%04x", c); o += b; } else o += c; }
  return o;
}
String hex(const uint8_t* d, size_t n) { static const char* H = "0123456789abcdef"; String o; o.reserve(n * 2); for (size_t i = 0; i < n; i++) { o += H[d[i] >> 4]; o += H[d[i] & 15]; } return o; }
bool waitLine(const char* prefix, String& out, uint32_t ms) {
  uint32_t t0 = millis();
  do {
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\n') { String l = rxbuf; rxbuf = ""; l.trim(); if (l.startsWith(prefix)) { out = l.substring(strlen(prefix)); return true; } }
      else if (c != '\r') rxbuf += c;
    }
    delay(1);
  } while (millis() - t0 < ms);
  return false;
}
}
int HTTPClient::sendRequest(const char* method, const uint8_t* body, size_t n) {
  String b; for (size_t i = 0; i < n; i++) b += (char)body[i];
  qemunet::sendLine(String("{\"k\":\"http\",\"method\":\"") + method + "\",\"url\":\"" + qemunet::jsonEsc(_url) + "\",\"headers\":{" + _hdrs + "},\"body\":\"" + qemunet::jsonEsc(b) + "\"}");
  String r;
  if (!qemunet::waitLine("@R ", r, _timeout)) return -1;     // HTTPC_ERROR_CONNECTION_REFUSED-like
  int sp = r.indexOf(' ');
  _resp = sp > 0 ? r.substring(sp + 1) : "";
  return r.toInt();
}
int WiFiUDP::endPacket() {
  qemunet::sendLine(String("{\"k\":\"udp\",\"dst\":\"") + _dst + "\",\"dport\":" + _dport + ",\"sport\":" + _port + ",\"hex\":\"" + qemunet::hex(_tx, _txn) + "\"}");
  return 1;
}
int WiFiUDP::parsePacket() {   // poll simulator for a datagram addressed to our port: "@U <ip> <srcport> <dstport> <hex>"
  String r;
  if (!qemunet::waitLine("@U ", r, 0)) return 0;
  int a = r.indexOf(' '), b = r.indexOf(' ', a + 1), c = r.indexOf(' ', b + 1);
  if (a < 0 || b < 0 || c < 0) return 0;
  _rip.fromString(r.substring(0, a)); _rport = r.substring(a + 1, b).toInt();
  String hx = r.substring(c + 1); _rxn = 0; _rxpos = 0;
  for (size_t i = 0; i + 1 < hx.length() && _rxn < (int)sizeof _rx; i += 2) _rx[_rxn++] = strtol(hx.substring(i, i + 2).c_str(), nullptr, 16);
  return _rxn;
}
