#include "WiFi.h"
#include "esp_netif.h"
#include "esp_eth.h"
#include "esp_event.h"
#include "esp_eth_mac_openeth.h"
#include "lwip/ip4_addr.h"
#include "lwip/netdb.h"
#include "lwip/netif.h"
#include "lwip/sockets.h"
#include "lwip/tcpip.h"
#include <errno.h>
#include <fcntl.h>
#include <string.h>
extern "C" esp_eth_mac_t *esp_eth_mac_new_openeth(const eth_mac_config_t *config);
QemuEthWiFiClass WiFi;
static esp_netif_t *s_netif; static volatile bool s_up; static bool s_started;
static void on_ip(void *, esp_event_base_t, int32_t, void *data) {
  ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
  s_up = true;
  // slirp restrict=on omits the DHCP router option, so the guest's gateway
  // stays 0.0.0.0 and an off-subnet datagram (the Eco plug at 10.13.37.2)
  // never reaches the hub. Point the route at slirp's 10.0.2.2. restrict=on
  // still drops TCP to that address and to the public internet; the frame
  // tap is what receives the datagram.
  esp_ip4_addr_t shown = e->ip_info.gw;
  if (netif_default && ip4_addr_isany(netif_ip4_gw(netif_default))) {
    ip4_addr_t slirp;
    IP4_ADDR(&slirp, 10, 0, 2, 2);
    LOCK_TCPIP_CORE();
    netif_set_gw(netif_default, &slirp);
    UNLOCK_TCPIP_CORE();
    shown.addr = slirp.addr;
  }
  Serial.printf("[qemu-eth] lwIP up on open_eth: " IPSTR " (gw " IPSTR ", DHCP)\n",
                IP2STR(&e->ip_info.ip), IP2STR(&shown));
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
// *.sim.internal / host.sim.internal (plus legacy *.wokwi.internal alias for older sketches) -> the simulator's slirp guestfwd address (mock devices)
extern "C" int __real_lwip_getaddrinfo(const char *n, const char *s, const struct addrinfo *h, struct addrinfo **r);
extern "C" int __wrap_lwip_getaddrinfo(const char *n, const char *s, const struct addrinfo *h, struct addrinfo **r) {
  const char *orig = n;
  if (n && (strstr(n, ".sim.internal") || strstr(n, "wokwi.internal"))) n = "10.0.2.100";
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
// Slirp restrict=on drops a SYN and does not send RST, so lwIP's SYN retransmits
// (3 s, then 6, 12, …) hold the sketch well past 6 s. Wait at most 3 s, then
// return an error. A virtual device that accepts still returns immediately.
static const int kConnectFailFastSec = 3;
static int connect_failfast(int s, const struct sockaddr *name, socklen_t namelen) {
  int flags = lwip_fcntl(s, F_GETFL, 0);
  if (flags < 0) flags = 0;
  lwip_fcntl(s, F_SETFL, flags | O_NONBLOCK);
  int rc = __real_lwip_connect(s, name, namelen);
  if (rc == 0 || errno != EINPROGRESS) {
    lwip_fcntl(s, F_SETFL, flags);
    return rc;
  }
  fd_set wset;
  FD_ZERO(&wset);
  FD_SET(s, &wset);
  struct timeval tv;
  tv.tv_sec = kConnectFailFastSec;
  tv.tv_usec = 0;
  int sel = lwip_select(s + 1, nullptr, &wset, nullptr, &tv);
  int err = ETIMEDOUT;
  if (sel > 0) {
    socklen_t len = sizeof err;
    if (lwip_getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &len) < 0) err = errno;
  }
  lwip_fcntl(s, F_SETFL, flags);
  if (err) { errno = err; return -1; }
  return 0;
}
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
      return connect_failfast(s, (struct sockaddr *)&a, sizeof a);
    }
  }
#endif
  return connect_failfast(s, name, namelen);
}
