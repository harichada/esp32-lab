// 16x2 I2C LCD clock with a set-time menu (LiquidCrystal_PCF8574, PCF8574 at 0x27)
// M = menu (set hours -> set minutes -> run), + = increase the selected field.
#include <Wire.h>
#include <LiquidCrystal_PCF8574.h>

LiquidCrystal_PCF8574 lcd(0x27);
const int MENU_PIN = 14, PLUS_PIN = 27;
const char *days[] = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"};
long base = 9L * 3600 + 41 * 60;     // 09:41:00 at boot
unsigned long t0 = 0;
int menu = 0;                         // 0 run, 1 hours, 2 minutes
byte bell[8] = {0b00100, 0b01110, 0b01110, 0b01110, 0b11111, 0b00000, 0b00100, 0b00000};

// Write only the characters that changed (each LCD byte is 6 I2C transfers through the PCF8574, so this keeps the
// loop fast and the buttons responsive).
char shownRow[2][17] = {"                ", "                "};
void put(int r, const char *s) {
  for (int c = 0; c < 16 && s[c]; c++) {
    if (shownRow[r][c] == s[c]) continue;
    int e = c; while (e < 16 && s[e] && shownRow[r][e] != s[e]) e++;
    lcd.setCursor(c, r);
    for (int i = c; i < e; i++) { lcd.write((uint8_t)s[i]); shownRow[r][i] = s[i]; }
    c = e - 1;
  }
}

long now() { return base + (millis() - t0) / 1000; }

bool pressed(int pin, bool &was) { bool b = digitalRead(pin); bool p = was && !b; was = b; return p; }

void setup() {
  Serial.begin(115200);
  pinMode(MENU_PIN, INPUT_PULLUP);
  pinMode(PLUS_PIN, INPUT_PULLUP);
  Wire.begin(); lcd.begin(16, 2);
  lcd.setBacklight(255);
  lcd.createChar(0, bell);
  lcd.setCursor(0, 0); lcd.print(" ESP32 LCD Clock");
  lcd.setCursor(0, 1); lcd.print("  M=menu  +=set ");
  delay(1500);
  lcd.clear();
  t0 = millis();
  Serial.println("LCD clock running");
}

void loop() {
  static bool wm = true, wp = true;
  static long lastLog = -1;
  if (pressed(MENU_PIN, wm)) { menu = (menu + 1) % 3; Serial.printf("menu %d\n", menu); }
  if (pressed(PLUS_PIN, wp) && menu) {
    base += menu == 1 ? 3600 : 60;
    if (menu == 2 && (now() / 60) % 60 == 0) base -= 3600;      // minutes wrap without touching the hour
    base %= 7L * 86400;
  }
  long t = now();
  bool blink = (millis() / 400) % 2;
  int h = (t / 3600) % 24, m = (t / 60) % 60, s = t % 60, d = (t / 86400) % 7;
  char row[17];
  if (menu == 1 && blink) snprintf(row, sizeof row, "    --:%02d:%02d    ", m, s);
  else if (menu == 2 && blink) snprintf(row, sizeof row, "    %02d:--:%02d    ", h, s);
  else snprintf(row, sizeof row, "    %02d:%02d:%02d    ", h, m, s);
  put(0, row);
  if (menu) snprintf(row, sizeof row, "SET %-7s  +  ", menu == 1 ? "HOURS" : "MINUTES");
  else snprintf(row, sizeof row, "%s  %s  %2d%cC %c", days[d], h < 12 ? "AM" : "PM", 21 + (s / 20), (char)0xDF, (m == 0 && s < 5) ? 0x08 : ' ');   // 0x08 = CGRAM 0 (bell), hourly chime
  put(1, row);
  if (s == 0 && t != lastLog) lastLog = t, Serial.printf("%02d:%02d\n", h, m);
  delay(10);
}
