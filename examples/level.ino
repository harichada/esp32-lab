// Digital spirit level / bubble inclinometer: MPU6050 tilt on an SSD1306.
// Drag the MPU6050 "Accel X/Y" sliders in the Inspector to tilt the board.
// The green LED (D25) lights when the board is within 1 degree of level; red (D26) when it is badly tilted.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_MPU6050.h>

const int LED_OK = 25, LED_BAD = 26;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_MPU6050 mpu;
float fx = 0, fy = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_OK, OUTPUT); pinMode(LED_BAD, OUTPUT);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  if (!mpu.begin(0x68)) Serial.println("MPU6050 not found");
  Serial.println("Spirit level: tilt the MPU6050 (Accel X/Y sliders)");
}

void loop() {
  sensors_event_t a, g, t; mpu.getEvent(&a, &g, &t);
  float ax = a.acceleration.x, ay = a.acceleration.y, az = a.acceleration.z;
  float pitch = atan2(ax, sqrt(ay * ay + az * az)) * RAD_TO_DEG;
  float roll = atan2(ay, sqrt(ax * ax + az * az)) * RAD_TO_DEG;
  fx = fx * 0.6 + pitch * 0.4; fy = fy * 0.6 + roll * 0.4;          // damped bubble
  bool level = fabs(fx) < 1 && fabs(fy) < 1, bad = fabs(fx) > 15 || fabs(fy) > 15;
  digitalWrite(LED_OK, level); digitalWrite(LED_BAD, bad);

  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE);
  const int cx = 32, cy = 32, R = 30;                             // round bull's-eye vial
  oled.drawCircle(cx, cy, R, SSD1306_WHITE); oled.drawCircle(cx, cy, 7, SSD1306_WHITE);
  oled.drawFastHLine(cx - R, cy, 6, SSD1306_WHITE); oled.drawFastHLine(cx + R - 6, cy, 6, SSD1306_WHITE);
  oled.drawFastVLine(cx, cy - R, 6, SSD1306_WHITE); oled.drawFastVLine(cx, cy + R - 6, 6, SSD1306_WHITE);
  float bxp = constrain(-fx, -30, 30) / 30.0 * (R - 6), byp = constrain(fy, -30, 30) / 30.0 * (R - 6);
  if (level) oled.fillCircle(cx + bxp, cy + byp, 5, SSD1306_WHITE); else oled.drawCircle(cx + bxp, cy + byp, 5, SSD1306_WHITE);
  oled.drawRect(68, 54, 60, 9, SSD1306_WHITE);                    // linear vial for the X axis
  oled.drawFastVLine(98, 54, 9, SSD1306_WHITE);
  oled.fillRect(98 + constrain(-fx, -25, 25) - 3, 56, 6, 5, SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(68, 2); oled.printf("X %+5.1f", fx); oled.setCursor(68, 14); oled.printf("Y %+5.1f", fy);
  oled.setCursor(68, 30); oled.setTextSize(level ? 2 : 1); oled.print(level ? "LEVEL" : bad ? "TILTED!" : "adjust..");
  oled.display();
  static unsigned long last; if (millis() - last > 1000) { last = millis(); Serial.printf("pitch %+5.1f  roll %+5.1f  %s\n", fx, fy, level ? "LEVEL" : bad ? "TILTED" : ""); }
  delay(50);
}
