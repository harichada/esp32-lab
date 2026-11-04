// OLED stopwatch with laps. START/STOP = key s (D14), LAP/RESET = key l (D13).
// Running: LAP records a split. Stopped: LAP/RESET clears.  Times also go to Serial.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int BTN_SS = 14, BTN_LAP = 13, LED_RUN = 25;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
bool running = false;
unsigned long startMs = 0, accum = 0, lastLap = 0;
unsigned long laps[3]; int nLaps = 0;
bool prevSS = HIGH, prevLap = HIGH;

unsigned long elapsed() { return accum + (running ? millis() - startMs : 0); }
void fmt(char *b, size_t n, unsigned long ms) { snprintf(b, n, "%02lu:%02lu.%02lu", ms / 60000, ms / 1000 % 60, ms / 10 % 100); }

void draw() {
  char b[16]; unsigned long e = elapsed();
  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1); oled.setCursor(0, 0); oled.print(running ? "> RUNNING" : e ? "|| STOPPED" : "STOPWATCH");
  oled.setCursor(98, 0); oled.printf("L%d", nLaps);
  fmt(b, sizeof b, e); oled.setTextSize(2); oled.setCursor(4, 14); oled.print(b);
  oled.drawFastHLine(0, 33, 128, SSD1306_WHITE);
  oled.setTextSize(1);
  for (int i = 0; i < min(nLaps, 3); i++) {
    fmt(b, sizeof b, laps[i]); oled.setCursor(0, 37 + i * 9); oled.printf("lap %-2d %s", nLaps - i, b);
  }
  if (!nLaps) { oled.setCursor(0, 40); oled.print("s: start/stop"); oled.setCursor(0, 50); oled.print("l: lap / reset"); }
  // progress ring for the seconds
  int s = e / 1000 % 60; oled.drawCircle(116, 48, 10, SSD1306_WHITE);
  float a = (s / 60.0) * TWO_PI - HALF_PI; oled.drawLine(116, 48, 116 + 9 * cos(a), 48 + 9 * sin(a), SSD1306_WHITE);
  oled.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN_SS, INPUT_PULLUP); pinMode(BTN_LAP, INPUT_PULLUP); pinMode(LED_RUN, OUTPUT);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  Serial.println("Stopwatch: s = start/stop, l = lap/reset");
  draw();
}

void loop() {
  bool ss = digitalRead(BTN_SS), lp = digitalRead(BTN_LAP);
  char b[16];
  if (ss == LOW && prevSS == HIGH) {
    if (running) { accum += millis() - startMs; running = false; fmt(b, sizeof b, accum); Serial.printf("stop  %s\n", b); }
    else { startMs = millis(); running = true; Serial.println("start"); }
    digitalWrite(LED_RUN, running);
  }
  if (lp == LOW && prevLap == HIGH) {
    if (running) {
      unsigned long e = elapsed(), split = e - lastLap; lastLap = e;
      memmove(laps + 1, laps, 2 * sizeof laps[0]); laps[0] = split; nLaps++;
      char t[16]; fmt(b, sizeof b, split); fmt(t, sizeof t, e); Serial.printf("lap %d  %s  (total %s)\n", nLaps, b, t);
    } else { accum = 0; lastLap = 0; nLaps = 0; Serial.println("reset"); }
  }
  bool changed = (ss != prevSS) || (lp != prevLap);
  prevSS = ss; prevLap = lp;
  static unsigned long lastDraw;
  if (changed || millis() - lastDraw >= 100) { lastDraw = millis(); draw(); }   // 10 fps keeps the CPU mostly idle
  delay(5);
}
