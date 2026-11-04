// Pong on a 128x64 OLED: your paddle follows the potentiometer (D34), the ESP32 plays the right side.
// First to 5 wins. Buzzer (D25) bleeps on every hit. Turn the knob (scroll over it) to play.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

const int POT = 34, BUZ = 25, PH = 14, WIN = 5;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
float bx, by, vx, vy, cpuY = 25; int you = 0, cpu = 0;

void serve(int dir) {
  bx = 64; by = random(16, 48); vx = 2.4 * dir; vy = random(-15, 16) / 10.0;
  if (fabs(vy) < 0.5) vy = 0.8;
}
void setup() {
  Serial.begin(115200);
  analogReadResolution(12);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  randomSeed(esp_random());
  serve(1);
  Serial.println("PONG - you are the left paddle (pot). First to 5!");
}

void loop() {
  int youY = map(analogRead(POT), 0, 4095, 0, 64 - PH);
  // CPU: follows the ball with a capped speed (beatable!)
  float target = by - PH / 2.0; cpuY += constrain(target - cpuY, -1.6, 1.6); cpuY = constrain(cpuY, 0, 64 - PH);
  bx += vx; by += vy;
  if (by < 1 || by > 62) { vy = -vy; by = constrain(by, 1, 62); }
  if (bx <= 4 && vx < 0) {
    if (by >= youY - 1 && by <= youY + PH + 1) { vx = -vx * 1.06; vy += (by - (youY + PH / 2.0)) * 0.18; tone(BUZ, 900, 25); }
    else { cpu++; Serial.printf("CPU scores  you %d : %d cpu\n", you, cpu); tone(BUZ, 200, 250); serve(1); }
  }
  if (bx >= 123 && vx > 0) {
    if (by >= cpuY - 1 && by <= cpuY + PH + 1) { vx = -vx * 1.04; vy += (by - (cpuY + PH / 2.0)) * 0.15; tone(BUZ, 1200, 25); }
    else { you++; Serial.printf("YOU score!  you %d : %d cpu\n", you, cpu); tone(BUZ, 1600, 120); serve(-1); }
  }
  vx = constrain(vx, -5, 5); vy = constrain(vy, -3, 3);

  oled.clearDisplay(); oled.setTextColor(SSD1306_WHITE);
  for (int y = 0; y < 64; y += 6) oled.drawFastVLine(64, y, 3, SSD1306_WHITE);
  oled.setTextSize(2); oled.setCursor(42, 2); oled.print(you); oled.setCursor(74, 2); oled.print(cpu);
  oled.fillRect(1, youY, 3, PH, SSD1306_WHITE); oled.fillRect(124, (int)cpuY, 3, PH, SSD1306_WHITE);
  oled.fillRect((int)bx - 1, (int)by - 1, 3, 3, SSD1306_WHITE);
  if (you == WIN || cpu == WIN) {
    oled.fillRect(14, 22, 100, 22, SSD1306_BLACK); oled.drawRect(14, 22, 100, 22, SSD1306_WHITE);
    oled.setTextSize(1); oled.setCursor(you == WIN ? 34 : 31, 30); oled.print(you == WIN ? "YOU WIN! :)" : "CPU WINS :(");
    oled.display();
    Serial.printf("%s %d-%d. New match in 3 s\n", you == WIN ? "You win" : "CPU wins", you, cpu);
    delay(3000); you = cpu = 0; serve(1); return;
  }
  oled.display();
  delay(15);
}
