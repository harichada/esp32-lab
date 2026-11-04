// Reaction-time game on an SSD1306 OLED.
// Press the button (key Enter, D14) to arm; wait for the green GO LED (D25) and hit it as fast as you can.
// Pressing too early lights the red LED (D26): false start!
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int BTN = 14, LED_GO = 25, LED_FOUL = 26;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
unsigned long best = 0, total = 0; int rounds = 0;

bool pressed() { return digitalRead(BTN) == LOW; }
void waitRelease() { while (pressed()) delay(5); delay(30); }

void screen(const char *big, const char *small1, const char *small2 = "") {
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1); oled.setCursor(0, 0); oled.print("REACTION TEST");
  oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);
  oled.setTextSize(2); oled.setCursor((128 - strlen(big) * 12) / 2, 20); oled.print(big);
  oled.setTextSize(1); oled.setCursor(0, 44); oled.print(small1);
  oled.setCursor(0, 54); oled.print(small2);
  oled.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN, INPUT_PULLUP);
  pinMode(LED_GO, OUTPUT); pinMode(LED_FOUL, OUTPUT);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  randomSeed(esp_random());
  Serial.println("Reaction game: press Enter to start a round");
}

void loop() {
  char l1[24], l2[24];
  if (rounds) { snprintf(l1, sizeof l1, "best %lu ms", best); snprintf(l2, sizeof l2, "avg  %lu ms (%d)", total / rounds, rounds); }
  else { strcpy(l1, "press the button"); strcpy(l2, "to start"); }
  screen("READY?", l1, l2);
  while (!pressed()) delay(5);
  waitRelease();

  screen("wait...", "hit the button when", "the GO LED lights");
  unsigned long wait = random(1500, 4000), t0 = millis();
  while (millis() - t0 < wait) {
    if (pressed()) {                                   // false start
      digitalWrite(LED_FOUL, HIGH);
      Serial.println("FALSE START!");
      screen("TOO SOON", "false start -", "round not counted");
      waitRelease(); delay(1200);
      digitalWrite(LED_FOUL, LOW);
      return;
    }
    delay(1);
  }
  digitalWrite(LED_GO, HIGH);
  unsigned long go = micros();
  oled.clearDisplay(); oled.fillRect(0, 0, 128, 64, SSD1306_WHITE);
  oled.setTextColor(SSD1306_BLACK); oled.setTextSize(4); oled.setCursor(28, 18); oled.print("GO!"); oled.display();
  while (!pressed()) {
    if (micros() - go > 3000000UL) { digitalWrite(LED_GO, LOW); Serial.println("too slow (>3 s)"); screen("ASLEEP?", "no press in 3 s"); delay(1200); return; }
  }
  unsigned long ms = (micros() - go) / 1000;
  digitalWrite(LED_GO, LOW);
  rounds++; total += ms; bool rec = !best || ms < best; if (rec) best = ms;
  Serial.printf("reaction: %lu ms%s  (best %lu, avg %lu over %d)\n", ms, rec ? "  NEW BEST!" : "", best, total / rounds, rounds);
  char big[12]; snprintf(big, sizeof big, "%lu ms", ms);
  screen(big, rec ? "*** new best! ***" : (ms < 250 ? "lightning fast" : ms < 400 ? "nice" : "keep practising"), "press to go again");
  waitRelease(); delay(400);
}
