// Electronic dice: two dice on an SSD1306. Press ROLL (key Enter, D14) - or shake the MPU6050
// (drag any accelerometer slider quickly in the Inspector) - to roll with a tumbling animation.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_MPU6050.h>

const int BTN = 14;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_MPU6050 mpu;
bool haveMpu;
int stats[13], rolls = 0;
float lastA = 9.81;

void die(int x, int y, int v) {                     // 28x28 die face with pips
  oled.fillRoundRect(x, y, 28, 28, 5, SSD1306_WHITE);
  const int L = x + 7, C = x + 14, R = x + 21, T = y + 7, M = y + 14, B = y + 21;
  auto pip = [&](int px, int py) { oled.fillCircle(px, py, 2, SSD1306_BLACK); };
  if (v & 1) pip(C, M);
  if (v >= 2) { pip(L, T); pip(R, B); }
  if (v >= 4) { pip(R, T); pip(L, B); }
  if (v == 6) { pip(L, M); pip(R, M); }
}

void show(int a, int b, int ox, int oy, const char *caption) {
  oled.clearDisplay();
  die(22 + ox, 8 + oy, a); die(78 - ox, 8 - oy, b);
  oled.setTextSize(1); oled.setTextColor(SSD1306_WHITE);
  oled.setCursor((128 - strlen(caption) * 6) / 2, 50); oled.print(caption);
  oled.display();
}

void roll(const char *why) {
  int a = 1, b = 1;
  for (int f = 0; f < 8; f++) {                     // tumble: random faces, jitter, slowing down
    a = random(1, 7); b = random(1, 7);
    show(a, b, random(-3, 4), random(-3, 4), "rolling...");
    delay(40 + f * 15);
  }
  rolls++; stats[a + b]++;
  char cap[24];
  if (a == b) snprintf(cap, sizeof cap, a == 6 ? "DOUBLE SIX!" : a == 1 ? "snake eyes!" : "doubles! = %d", a + b);
  else snprintf(cap, sizeof cap, "%d + %d = %d", a, b, a + b);
  show(a, b, 0, 0, cap);
  Serial.printf("roll #%d (%s): %d + %d = %d%s\n", rolls, why, a, b, a + b, a == b ? "  doubles!" : "");
  if (rolls % 10 == 0) {
    Serial.print("  totals so far:");
    for (int s = 2; s <= 12; s++) Serial.printf(" %d:%d", s, stats[s]);
    Serial.println();
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN, INPUT_PULLUP);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  haveMpu = mpu.begin(0x68);
  Serial.printf("Dice ready (MPU6050 %s). Press Enter to roll%s.\n", haveMpu ? "found" : "missing", haveMpu ? " or shake" : "");
  randomSeed(esp_random());
  if (haveMpu) { sensors_event_t e, g, t; mpu.getEvent(&e, &g, &t);   // baseline so boot is not mistaken for a shake
    lastA = sqrt(e.acceleration.x * e.acceleration.x + e.acceleration.y * e.acceleration.y + e.acceleration.z * e.acceleration.z); }
  show(6, 6, 0, 0, "press ROLL / shake");
}

void loop() {
  if (digitalRead(BTN) == LOW) { roll("button"); while (digitalRead(BTN) == LOW) delay(5); delay(30); }
  if (haveMpu) {
    sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
    float m = sqrt(a.acceleration.x * a.acceleration.x + a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z);
    if (fabs(m - lastA) > 4.0) { lastA = m; roll("shake"); delay(300); return; }
    lastA = m;
  }
  delay(30);
}
