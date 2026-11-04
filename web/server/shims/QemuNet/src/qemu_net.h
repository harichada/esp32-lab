#pragma once
#include <Arduino.h>
#include <IPAddress.h>
namespace qemunet {
void sendLine(const String& json);
bool waitLine(const char* prefix, String& out, uint32_t ms);   // reads UART0 RX for a line starting with prefix
String jsonEsc(const String& s);
String hex(const uint8_t* d, size_t n);
}
