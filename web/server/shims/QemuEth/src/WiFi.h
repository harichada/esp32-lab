#pragma once
// QEMU: no Wi-Fi radio, so "WiFi" is a real esp_netif/lwIP interface on QEMU's open_eth NIC (slirp user net).
#include <Arduino.h>
#include <Network.h>
#include <NetworkClient.h>
#include "WiFiUdp.h"
typedef enum { WL_IDLE_STATUS = 0, WL_NO_SSID_AVAIL = 1, WL_CONNECTED = 3, WL_CONNECT_FAILED = 4, WL_DISCONNECTED = 6 } wl_status_t;
#ifndef WIFI_STA
#define WIFI_OFF 0
#define WIFI_STA 1
#define WIFI_AP 2
#define WIFI_AP_STA 3
#endif
typedef NetworkClient WiFiClient;
class QemuEthWiFiClass {
 public:
  wl_status_t begin(const char* ssid, const char* pass = nullptr);
  wl_status_t status();
  bool mode(int) { return true; }
  bool setSleep(bool) { return true; }
  bool disconnect(bool = false, bool = false) { return true; }
  bool isConnected() { return status() == WL_CONNECTED; }
  IPAddress localIP();
  String macAddress() { return "02:00:00:00:00:01"; }
  int RSSI() { return -40; }
};
extern QemuEthWiFiClass WiFi;
