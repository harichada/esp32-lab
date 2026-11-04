#pragma once
#include "qemu_net.h"
#define HTTPC_ERROR_CONNECTION_REFUSED (-1)
class HTTPClient {
 public:
  String _url, _hdrs; uint16_t _timeout = 5000; String _resp;
  void setTimeout(uint16_t ms) { _timeout = ms; }
  void setConnectTimeout(int32_t ms) {}
  bool begin(const String& url) { _url = url; _hdrs = ""; return true; }
  void addHeader(const String& k, const String& v, bool = false, bool = true) {
    if (_hdrs.length()) _hdrs += ",";
    _hdrs += "\"" + qemunet::jsonEsc(k) + "\":\"" + qemunet::jsonEsc(v) + "\"";
  }
  int sendRequest(const char* method, const uint8_t* body, size_t n);
  int POST(const String& body) { return sendRequest("POST", (const uint8_t*)body.c_str(), body.length()); }
  int POST(uint8_t* body, size_t n) { return sendRequest("POST", body, n); }
  int GET() { return sendRequest("GET", nullptr, 0); }
  String getString() { return _resp; }
  void end() {}
};
