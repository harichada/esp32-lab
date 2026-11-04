#include "WiFi.h"
#include "esp_netif.h"
#include "esp_eth.h"
#include "esp_event.h"
#include "esp_eth_mac_openeth.h"
#include "lwip/netdb.h"
#include "lwip/sockets.h"
#include <string.h>
extern "C" esp_eth_mac_t *esp_eth_mac_new_openeth(const eth_mac_config_t *config);
QemuEthWiFiClass WiFi;
static esp_netif_t *s_netif; static volatile bool s_up; static bool s_started;
static void on_ip(void *, esp_event_base_t, int32_t, void *data) {
  ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
  s_up = true;
  Serial.printf("[qemu-eth] lwIP up on open_eth: " IPSTR " (gw " IPSTR ", DHCP)\n", IP2STR(&e->ip_info.ip), IP2STR(&e->ip_info.gw));
}
wl_status_t QemuEthWiFiClass::begin(const char *ssid, const char *) {
  if (s_started) return status();
  s_started = true;
  Network.begin();   // esp_netif_init + default event loop
  eth_mac_config_t mc = ETH_MAC_DEFAULT_CONFIG();
  eth_phy_config_t pc = ETH_PHY_DEFAULT_CONFIG();
  pc.autonego_timeout_ms = 100; pc.reset_gpio_num = -1;
  esp_eth_mac_t *mac = esp_eth_mac_new_openeth(&mc);
  esp_eth_phy_t *phy = esp_eth_phy_new_dp83848(&pc);
  esp_eth_config_t cfg = ETH_DEFAULT_CONFIG(mac, phy);
  esp_eth_handle_t h = nullptr;
  if (!mac || !phy || esp_eth_driver_install(&cfg, &h) != ESP_OK) { Serial.println("[qemu-eth] open_eth driver install failed"); return WL_CONNECT_FAILED; }
  esp_netif_config_t nc = ESP_NETIF_DEFAULT_ETH();
  s_netif = esp_netif_new(&nc);
  esp_netif_attach(s_netif, esp_eth_new_netif_glue(h));
  esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP, on_ip, nullptr);
  esp_eth_start(h);
  Serial.printf("[qemu-eth] WiFi.begin(\"%s\") -> open_eth + DHCP (slirp)\n", ssid ? ssid : "");
  return WL_DISCONNECTED;
}
wl_status_t QemuEthWiFiClass::status() { return s_up ? WL_CONNECTED : WL_DISCONNECTED; }
IPAddress QemuEthWiFiClass::localIP() {
  esp_netif_ip_info_t i; if (s_netif && esp_netif_get_ip_info(s_netif, &i) == ESP_OK) return IPAddress(i.ip.addr); return IPAddress();
}
// *.wokwi.internal / host.wokwi.internal -> the simulator's slirp guestfwd address (mock devices)
extern "C" int __real_lwip_getaddrinfo(const char *n, const char *s, const struct addrinfo *h, struct addrinfo **r);
extern "C" int __wrap_lwip_getaddrinfo(const char *n, const char *s, const struct addrinfo *h, struct addrinfo **r) {
  const char *orig = n;
  if (n && strstr(n, "wokwi.internal")) n = "10.0.2.100";
  int rc = __real_lwip_getaddrinfo(n, s, h, r);
  char ip[16] = "?";
  if (rc == 0 && r && *r && (*r)->ai_addr) inet_ntoa_r(((struct sockaddr_in *)(*r)->ai_addr)->sin_addr, ip, sizeof ip);
  if (orig && strcmp(orig, ip)) Serial.printf("[qemu-eth] DNS %s -> %s%s\n", orig, rc ? "FAILED" : ip, n != orig ? " (simulator virtual devices)" : "");
  return rc;
}
// Virtual LAN: the box has no Sony/Roku on 192.168.x.x, so TCP connects to private-LAN addresses (192.168/16, 172.16/12,
// 10/8 except slirp's 10.0.2/24) on the ports the virtual devices serve (80, 8060, 8080) are redirected to the simulator's
// virtual devices at 10.0.2.100. Build with -DSIM_NO_LAN_REMAP to disable (then such connects go out via slirp).
extern "C" int __real_lwip_connect(int s, const struct sockaddr *name, socklen_t namelen);
extern "C" int __wrap_lwip_connect(int s, const struct sockaddr *name, socklen_t namelen) {
#ifndef SIM_NO_LAN_REMAP
  if (name && name->sa_family == AF_INET && namelen >= sizeof(struct sockaddr_in)) {
    struct sockaddr_in a; memcpy(&a, name, sizeof a);
    uint32_t ip = ntohl(a.sin_addr.s_addr); uint16_t port = ntohs(a.sin_port);
    bool lan = (ip >> 16) == 0xC0A8 || (ip >> 20) == 0xAC1 || ((ip >> 24) == 10 && (ip >> 8) != 0x0A0002);
    if (lan && (port == 80 || port == 8060 || port == 8080)) {
      char o[16]; inet_ntoa_r(a.sin_addr, o, sizeof o);
      Serial.printf("[qemu-eth] connect %s:%u -> virtual device 10.0.2.100:%u (LAN remap)\n", o, port, port);
      a.sin_addr.s_addr = htonl(0x0A000264);
      return __real_lwip_connect(s, (struct sockaddr *)&a, sizeof a);
    }
  }
#endif
  return __real_lwip_connect(s, name, namelen);
}
