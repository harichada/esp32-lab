// NeoPixel light show: 16-LED WS2812 ring (Adafruit_NeoPixel)
// M = next effect (rainbow, fire, comet, breathing), knob = brightness.
#include <Adafruit_NeoPixel.h>

const int RING_PIN = 5, N = 16, MODE_PIN = 14, POT_PIN = 34;
Adafruit_NeoPixel ring(N, RING_PIN, NEO_GRB + NEO_KHZ800);
const char *names[] = {"rainbow", "fire", "comet", "breathing"};
int mode = 0;
uint8_t heat[N];
uint16_t hue0 = 0;
int head = 0;

void setup() {
  Serial.begin(115200);
  pinMode(MODE_PIN, INPUT_PULLUP);
  ring.begin();
  ring.show();
  Serial.println("NeoPixel ring: M = next effect, knob = brightness");
  Serial.printf("effect: %s\n", names[mode]);
}

uint32_t heatColor(uint8_t t) {          // black -> red -> orange -> yellow -> white
  uint8_t r = t > 85 ? 255 : t * 3, g = t > 170 ? 255 : t > 85 ? (t - 85) * 3 : 0, b = t > 170 ? (t - 170) * 3 : 0;
  return ring.Color(r, g, b);
}

void loop() {
  static bool was = HIGH;
  bool b = digitalRead(MODE_PIN);
  if (was == HIGH && b == LOW) { mode = (mode + 1) % 4; Serial.printf("effect: %s\n", names[mode]); ring.clear(); }
  was = b;
  ring.setBrightness(map(analogRead(POT_PIN), 0, 4095, 8, 255));

  switch (mode) {
    case 0:   // rainbow wheel turning around the ring
      for (int i = 0; i < N; i++) ring.setPixelColor(i, ring.gamma32(ring.ColorHSV(hue0 + i * 65536L / N)));
      hue0 += 1024;
      break;
    case 1:   // fire: heat diffuses up both halves of the ring from the bottom
      for (int i = 0; i < N; i++) heat[i] = max(0, heat[i] - (int)random(0, 30));
      for (int i = N / 2; i > 0; i--) { heat[i] = (heat[i - 1] + heat[i] + heat[(i + 1) % N]) / 3; heat[N - i] = heat[i]; }
      if (random(10) < 7) heat[0] = min(255, heat[0] + (int)random(120, 255));
      for (int i = 0; i < N; i++) ring.setPixelColor((i + N / 2) % N, heatColor(heat[i]));
      break;
    case 2:   // comet with a fading tail
      for (int i = 0; i < N; i++) {
        int d = (head - i + N) % N;
        ring.setPixelColor(i, d < 6 ? ring.Color(0, 255 >> d, 255 >> (d / 2)) : 0);
      }
      head = (head + 1) % N;
      break;
    case 3: {  // breathing purple
      uint8_t v = (sin(millis() / 600.0) + 1) * 127;
      ring.fill(ring.Color(v, 0, v / 2));
      break;
    }
  }
  ring.show();
  delay(40);
}
