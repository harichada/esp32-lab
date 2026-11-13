// Egress probe. Build with compiler defines SIM and SIM_NO_LAN_REMAP.
// A #define in this file does not reach qemu_eth.cpp, so SIM_NO_LAN_REMAP has
// to be a compiler define. Without it, TCP to 10.0.0.1:80 and 192.168.1.1:80
// is rewritten to the virtual devices at 10.0.2.100 and looks OPEN.
// Optional: SIM_EGRESS_HOST="10.0.0.1"
// Pass under SIM_QEMU_NET_RESTRICT=1 is five BLOCKED lines, then EGRESS DONE.
#include <WiFi.h>

#ifndef SIM_EGRESS_HOST
#define SIM_EGRESS_HOST "10.0.0.1"
#endif

static void probe(const char *ip, uint16_t port) {
  WiFiClient client;
  bool open = client.connect(ip, port, 3000);
  Serial.printf("EGRESS %s:%u %s\n", ip, port, open ? "OPEN" : "BLOCKED");
  client.stop();
}

void setup() {
  Serial.begin(115200);
  WiFi.begin("SIM-GUEST", "");
  uint32_t t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 8000) delay(50);
  probe("169.254.169.254", 80);
  probe("10.0.2.2", 8765);
  probe(SIM_EGRESS_HOST, 80);
  probe("192.168.1.1", 80);
  probe("1.1.1.1", 80);
  Serial.println("EGRESS DONE");
}

void loop() {}
