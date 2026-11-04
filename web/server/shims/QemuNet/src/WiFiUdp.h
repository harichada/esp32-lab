#pragma once
#include "qemu_net.h"
class WiFiUDP {
 public:
  uint16_t _port = 0; String _dst; uint16_t _dport = 0; uint8_t _tx[1500]; size_t _txn = 0;
  uint8_t _rx[1500]; int _rxn = 0, _rxpos = 0; IPAddress _rip; uint16_t _rport = 0;
  uint8_t begin(uint16_t port) { _port = port ? port : 40000 + (esp_random() % 1000); return 1; }
  void stop() { _port = 0; }
  int beginPacket(IPAddress ip, uint16_t port) { _dst = ip.toString(); _dport = port; _txn = 0; return 1; }
  int beginPacket(const char* host, uint16_t port) { _dst = host; _dport = port; _txn = 0; return 1; }
  size_t write(uint8_t b) { if (_txn < sizeof _tx) _tx[_txn++] = b; return 1; }
  size_t write(const uint8_t* b, size_t n) { for (size_t i = 0; i < n; i++) write(b[i]); return n; }
  int endPacket();
  int parsePacket();
  int available() { return _rxn - _rxpos; }
  int read() { return _rxpos < _rxn ? _rx[_rxpos++] : -1; }
  int read(uint8_t* b, size_t n) { int k = 0; while (k < (int)n && _rxpos < _rxn) b[k++] = _rx[_rxpos++]; return k; }
  int read(char* b, size_t n) { return read((uint8_t*)b, n); }
  IPAddress remoteIP() { return _rip; }
  uint16_t remotePort() { return _rport; }
  void flush() {}
};
