// ESP32 simulator (QEMU) back end for Adafruit_NeoPixel::show(): QEMU's RMT model cannot stream a WS2812 bit train,
// so the pixel bytes (wire order, e.g. GRB) are sent to the simulator as one UART control line: "\x1ePX <pin> <hex>\n".
// Identical consecutive frames are skipped but repeated every 500 ms so a page opened late still gets the picture.
#include <Arduino.h>
#include <string.h>

extern "C" void espInit() {}

static uint8_t lastBuf[3 * 300 + 4];
static uint32_t lastLen = 0, lastMs = 0;
static int lastPin = -1;

extern "C" void espShow(uint16_t pin, uint8_t *pixels, uint32_t numBytes, bool is800KHz) {
  (void)is800KHz;
  if (numBytes > sizeof(lastBuf)) numBytes = sizeof(lastBuf);
  uint32_t now = millis();
  if ((int)pin == lastPin && numBytes == lastLen && memcmp(lastBuf, pixels, numBytes) == 0 && now - lastMs < 500) return;
  memcpy(lastBuf, pixels, numBytes); lastLen = numBytes; lastPin = pin; lastMs = now;
  static const char hx[] = "0123456789abcdef";
  static char line[2 * sizeof(lastBuf) + 24];
  int n = snprintf(line, 16, "\x1ePX %u ", (unsigned)pin);
  for (uint32_t i = 0; i < numBytes; i++) { line[n++] = hx[pixels[i] >> 4]; line[n++] = hx[pixels[i] & 15]; }
  line[n++] = '\n';
  if (Serial.baudRate() == 0) Serial.begin(115200);
  Serial.write((const uint8_t *)line, n);
}
