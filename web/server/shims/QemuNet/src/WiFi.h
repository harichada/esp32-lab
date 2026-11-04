#pragma once
// QEMU shim: Wi-Fi radio is not emulated by QEMU, so WiFi is "connected" to the simulator's virtual LAN.
#include "qemu_net.h"
#include "WiFiUdp.h"
typedef enum { WL_IDLE_STATUS = 0, WL_NO_SSID_AVAIL = 1, WL_CONNECTED = 3, WL_CONNECT_FAILED = 4, WL_DISCONNECTED = 6 } wl_status_t;
#ifndef WIFI_STA
#define WIFI_OFF 0
#define WIFI_STA 1
#define WIFI_AP 2
#define WIFI_AP_STA 3
#endif
class QemuWiFiClass {
 public:
  wl_status_t _st = WL_DISCONNECTED;
  wl_status_t begin(const char* ssid, const char* pass = nullptr) {
    qemunet::sendLine(String("{\"k\":\"wifi\",\"ssid\":\"") + qemunet::jsonEsc(ssid) + "\"}");
    _st = WL_CONNECTED; return _st;
  }
  wl_status_t status() { return _st; }
  bool mode(int) { return true; }
  bool setSleep(bool) { return true; }
  bool disconnect(bool = false, bool = false) { _st = WL_DISCONNECTED; return true; }
  bool isConnected() { return _st == WL_CONNECTED; }
  IPAddress localIP() { return IPAddress(192, 168, 1, 77); }
  String macAddress() { return "24:0A:C4:00:00:01"; }
  int RSSI() { return -40; }
};
extern QemuWiFiClass WiFi;
