// Snake on a 128x64 OLED. Steer with the arrow keys (buttons on D13 up, D14 down, D27 left, D26 right).
// Eat the food to grow; the game speeds up as you go. Buzzer on D25 beeps when you eat.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int B_UP = 13, B_DN = 14, B_LT = 27, B_RT = 26, BUZ = 25;
const int CELL = 4, GW = 32, GH = 13, TOP = 11;          // 32x13 board under a score bar
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
struct P { int8_t x, y; };
P body[GW * GH]; int len, dx, dy, score, hiscore = 0, stepMs;
P food; bool alive;

bool on(int x, int y) { for (int i = 0; i < len; i++) if (body[i].x == x && body[i].y == y) return true; return false; }
void place() { do { food = { (int8_t)random(GW), (int8_t)random(GH) }; } while (on(food.x, food.y)); }
void reset() {
  len = 4; for (int i = 0; i < len; i++) body[i] = { (int8_t)(8 - i), 6 };
  dx = 1; dy = 0; score = 0; stepMs = 220; alive = true; place();
  Serial.println("new game - arrow keys to steer");
}
void draw() {
  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE); oled.setTextSize(1);
  oled.setCursor(0, 1); oled.printf("SNAKE  %d", score); oled.setCursor(80, 1); oled.printf("HI %d", hiscore);
  oled.drawRect(0, TOP - 2, 128, GH * CELL + 3, SSD1306_WHITE);
  for (int i = 0; i < len; i++) oled.fillRect(body[i].x * CELL, TOP + body[i].y * CELL, CELL - (i ? 1 : 0), CELL - (i ? 1 : 0), SSD1306_WHITE);
  oled.drawCircle(food.x * CELL + 1, TOP + food.y * CELL + 1, 1, SSD1306_WHITE);
  if (!alive) {
    oled.fillRect(24, 22, 80, 24, SSD1306_BLACK); oled.drawRect(24, 22, 80, 24, SSD1306_WHITE);
    oled.setCursor(37, 26); oled.print("GAME OVER"); oled.setCursor(30, 36); oled.print("press a key");
  }
  oled.display();
}
void input() {
  if (digitalRead(B_UP) == LOW && dy == 0) { dx = 0; dy = -1; }
  else if (digitalRead(B_DN) == LOW && dy == 0) { dx = 0; dy = 1; }
  else if (digitalRead(B_LT) == LOW && dx == 0) { dx = -1; dy = 0; }
  else if (digitalRead(B_RT) == LOW && dx == 0) { dx = 1; dy = 0; }
}
bool anyKey() { return !digitalRead(B_UP) || !digitalRead(B_DN) || !digitalRead(B_LT) || !digitalRead(B_RT); }

void setup() {
  Serial.begin(115200);
  for (int p : { B_UP, B_DN, B_LT, B_RT }) pinMode(p, INPUT_PULLUP);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  randomSeed(esp_random());
  reset(); draw();
}

void loop() {
  if (!alive) {
    if (anyKey()) { while (anyKey()) delay(10); reset(); }
    delay(20); return;
  }
  unsigned long t0 = millis();
  while (millis() - t0 < (unsigned long)stepMs) { input(); delay(5); }
  P h = { (int8_t)(body[0].x + dx), (int8_t)(body[0].y + dy) };
  if (h.x < 0 || h.y < 0 || h.x >= GW || h.y >= GH || on(h.x, h.y)) {
    alive = false; if (score > hiscore) hiscore = score;
    Serial.printf("crash! score %d (high score %d)\n", score, hiscore);
    tone(BUZ, 120, 500); draw(); delay(600); return;
  }
  bool eat = h.x == food.x && h.y == food.y;
  if (eat) len++;
  memmove(body + 1, body, (len - 1) * sizeof(P)); body[0] = h;
  if (eat) { score++; stepMs = max(90, stepMs - 8); tone(BUZ, 1800, 40); Serial.printf("yum! score %d, length %d\n", score, len); place(); }
  draw();
}
