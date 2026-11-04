// remote_logic.h — pure (hardware-free) key -> command logic for the ESP32 Wi-Fi remote.
// Used by firmware/remote.ino and by the native test harness (tests/). No Arduino dependencies.
#pragma once
#include <stdint.h>
#include <string.h>
#include <string>

enum Btn { B_NONE=0, S_ON, S_OFF, S_VOLUP, S_VOLDN, S_MUTE, S_INPUT, S_UP, S_DOWN, S_LEFT, S_RIGHT,
           S_OK, S_BACK, S_HOME, R_SELECT, R_HOME, R_BACK, MODE, ECO_TOGGLE };
// Matrix layout [row][col]  (see wiring_table.md)
static const Btn KEYMAP[4][5] = {
  { S_ON,   S_OFF,   S_VOLUP, S_VOLDN, S_MUTE },
  { S_INPUT,S_UP,    S_DOWN,  S_LEFT,  S_RIGHT },
  { S_OK,   S_BACK,  S_HOME,  R_SELECT,R_HOME },
  { R_BACK, MODE,    ECO_TOGGLE, B_NONE, B_NONE },
};

enum CmdKind { C_NONE, C_SONY_POWER, C_SONY_IRCC, C_ROKU, C_MODE, C_ECO };
struct Cmd { CmdKind kind; const char* arg; bool on; };   // arg = IRCC code or Roku key; on = power state

inline Cmd keyCommand(Btn b, bool rokuMode) {
  switch (b) {
    case S_ON:    return {C_SONY_POWER, nullptr, true};
    case S_OFF:   return {C_SONY_POWER, nullptr, false};
    case S_VOLUP: return {C_SONY_IRCC, "AAAAAQAAAAEAAAASAw==", false};
    case S_VOLDN: return {C_SONY_IRCC, "AAAAAQAAAAEAAAATAw==", false};
    case S_MUTE:  return {C_SONY_IRCC, "AAAAAQAAAAEAAAAUAw==", false};
    case S_INPUT: return {C_SONY_IRCC, "AAAAAQAAAAEAAAAlAw==", false};
    case S_UP:    return rokuMode ? Cmd{C_ROKU, "Up", false}    : Cmd{C_SONY_IRCC, "AAAAAQAAAAEAAAB0Aw==", false};
    case S_DOWN:  return rokuMode ? Cmd{C_ROKU, "Down", false}  : Cmd{C_SONY_IRCC, "AAAAAQAAAAEAAAB1Aw==", false};
    case S_LEFT:  return rokuMode ? Cmd{C_ROKU, "Left", false}  : Cmd{C_SONY_IRCC, "AAAAAQAAAAEAAAA0Aw==", false};
    case S_RIGHT: return rokuMode ? Cmd{C_ROKU, "Right", false} : Cmd{C_SONY_IRCC, "AAAAAQAAAAEAAAAzAw==", false};
    case S_OK:    return {C_SONY_IRCC, "AAAAAQAAAAEAAABlAw==", false};
    case S_BACK:  return {C_SONY_IRCC, "AAAAAgAAAJcAAAAjAw==", false};
    case S_HOME:  return {C_SONY_IRCC, "AAAAAQAAAAEAAABgAw==", false};
    case R_SELECT: return {C_ROKU, "Select", false};
    case R_HOME:  return {C_ROKU, "Home", false};
    case R_BACK:  return {C_ROKU, "Back", false};
    case ECO_TOGGLE: return {C_ECO, nullptr, false};
    case MODE:    return {C_MODE, nullptr, false};
    default:      return {C_NONE, nullptr, false};
  }
}

inline std::string sonyIrccBody(const char* code) {
  std::string body = "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" "
                "s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>"
                "<u:X_SendIRCC xmlns:u=\"urn:schemas-sony-com:service:IRCC:1\"><IRCCCode>";
  body += code;
  body += "</IRCCCode></u:X_SendIRCC></s:Body></s:Envelope>";
  return body;
}
static const char* SONY_IRCC_CTYPE = "text/xml; charset=UTF-8";
static const char* SONY_IRCC_SOAPACTION = "\"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC\"";
inline std::string sonyPowerBody(bool on) {
  return std::string("{\"method\":\"setPowerStatus\",\"id\":55,\"params\":[{\"status\":") + (on ? "true" : "false") + "}],\"version\":\"1.0\"}";
}

// Legacy Eco Plug header (128 B) + optional {0x01,state} payload. Returns length.
inline size_t ecoLegacyPacket(uint8_t* pkt /*>=130*/, const char* id, bool write, bool on, uint16_t xid, uint32_t t) {
  memset(pkt, 0, 130);
  pkt[0] = write ? 0x16 : 0x17; pkt[2] = 0x05;
  pkt[6] = xid & 0xFF; pkt[7] = xid >> 8;
  pkt[8] = write ? 2 : 0;
  strncpy((char*)pkt + 16, id, 32);
  memcpy(pkt + 116, &t, 4);
  const uint8_t magic[4] = {0xAE, 0x49, 0x52, 0x0D}; memcpy(pkt + 124, magic, 4);
  if (write) { pkt[128] = 0x01; pkt[129] = on ? 0x01 : 0x00; return 130; }
  return 128;
}

// KAB fixed-body set (kunalkhosla craft_command: body XOR txid, opcode 0x6A @76, state @80). 152 B.
inline void kabBuildFixed(uint8_t* b, bool on, uint32_t rnd) {
  static const uint8_t body[56] = {0x79,0x76,0x51,0x43,0x3b,0x77,0x77,0x74,0x22,0x40,0x22,0x26,0x1b,0x27,0x33,0x39,0x24,0x34,0x44,0x4c,
    0x1a,0x79,0x65,0x1c,0x73,0x7c,0x22,0x33,0x3f,0x5b,0x77,0x85,0x48,0x68,0x88,0x98,0x51,0x75,0x99,0xab,0x5a,0x82,0xaa,0xbe,0x63,0x8f,0xbb,0xd1,
    0x0d,0x97,0x1f,0x2a,0x0d,0xff,0xe9,0xe5};
  static const uint8_t hdr[12] = {0x17,0,0,0,0,0,0,0,0xda,0xe2,0x0c,0x00};
  memset(b, 0, 152);
  b[0] = rnd; b[1] = rnd >> 8; b[2] = 0x2d; b[3] = 0xac; memcpy(b + 4, hdr, 12);
  for (int i = 0; i < 56; i++) b[16 + i] = body[i] ^ b[i % 4];
  b[76] = 0x6A; b[80] = on ? 1 : 0;
}

// Debounced matrix scanner state machine (identical logic to firmware scan()).
// readCol(r,c) returns true if COL c reads LOW while only ROW r is driven LOW.
struct MatrixScanner {
  static const uint32_t DEBOUNCE_MS = 30;
  bool stable[4][5] = {}, lastRaw[4][5] = {};
  uint32_t changedAt[4][5] = {};
  template <class ReadFn, class OnPress>
  void scan(uint32_t now, ReadFn readCol, OnPress onPress) {
    for (int r = 0; r < 4; r++) for (int c = 0; c < 5; c++) {
      bool pressed = readCol(r, c);
      if (pressed != lastRaw[r][c]) { lastRaw[r][c] = pressed; changedAt[r][c] = now; }
      if (pressed != stable[r][c] && now - changedAt[r][c] >= DEBOUNCE_MS) {
        stable[r][c] = pressed;
        if (pressed && KEYMAP[r][c] != B_NONE) onPress(KEYMAP[r][c]);
      }
    }
  }
};

// ---------------- Sony SIRC IR (for powering ON a TV that is fully off / Wi-Fi asleep) ----------------
// Codes in IRremoteESP8266/LIRC "bit" notation (first transmitted bit = MSB of the value), 12-bit, device 1 (TV):
//   0xA90 = cmd 21 Power toggle, 0x750 = cmd 46 discrete Power ON, 0xF50 = cmd 47 discrete Power OFF,
//   0x490 Vol+ (18), 0xC90 Vol- (19), 0x290 Mute (20), 0xA50 Input (37).
// Refs: LIRC Sony RM-854 conf (power 0xA90 / power_on 0x750 / power_off 0xF50), Tasmota IR codes, sbprojects SIRC.
static const uint16_t SIRC_POWER = 0xA90, SIRC_POWER_ON = 0x750, SIRC_POWER_OFF = 0xF50,
                      SIRC_VOLUP = 0x490, SIRC_VOLDN = 0xC90, SIRC_MUTE = 0x290, SIRC_INPUT = 0xA50;
static const uint32_t SIRC_CARRIER_HZ = 40000;
static const uint16_t SIRC_HDR_US = 2400, SIRC_ONE_US = 1200, SIRC_ZERO_US = 600, SIRC_SPACE_US = 600;
static const uint32_t SIRC_FRAME_US = 45000;     // start-to-start spacing between repeats
static const int SIRC_REPEATS = 3;               // Sony receivers want >= 3 identical frames

// Build value from Sony (command 7 bits, device 5/8 bits) — both sent LSB first.
inline uint32_t sircFromCmd(uint8_t cmd, uint16_t dev, int nbits = 12) {
  uint32_t raw = (cmd & 0x7F) | ((uint32_t)dev << 7);       // in transmit order, LSB = first bit
  uint32_t v = 0; for (int i = 0; i < nbits; i++) v = (v << 1) | ((raw >> i) & 1);
  return v;
}
// Pure encoder: fills mark/space pairs (us) for one frame; last space pads to SIRC_FRAME_US. Returns #pairs (= nbits+1).
inline int sircEncodeFrame(uint32_t data, int nbits, uint16_t* mark, uint32_t* space) {
  uint32_t used = SIRC_HDR_US + SIRC_SPACE_US; mark[0] = SIRC_HDR_US; space[0] = SIRC_SPACE_US;
  for (int i = 0; i < nbits; i++) {
    bool one = (data >> (nbits - 1 - i)) & 1;
    mark[i + 1] = one ? SIRC_ONE_US : SIRC_ZERO_US; space[i + 1] = SIRC_SPACE_US;
    used += mark[i + 1] + SIRC_SPACE_US;
  }
  space[nbits] = SIRC_FRAME_US - used + SIRC_SPACE_US;      // trailing gap to keep 45 ms start-to-start
  return nbits + 1;
}

// IR use per key. IR_FALLBACK: when true, vol/mute/input also go over IR (default off: IR only for power).
#ifndef IR_FALLBACK
#define IR_FALLBACK 0
#endif
inline uint16_t irCodeFor(Btn b, bool irFallback = IR_FALLBACK) {
  switch (b) {
    case S_ON:  return SIRC_POWER_ON;
    case S_OFF: return SIRC_POWER_OFF;
    case S_VOLUP: return irFallback ? SIRC_VOLUP : 0;
    case S_VOLDN: return irFallback ? SIRC_VOLDN : 0;
    case S_MUTE:  return irFallback ? SIRC_MUTE : 0;
    case S_INPUT: return irFallback ? SIRC_INPUT : 0;
    default: return 0;
  }
}
