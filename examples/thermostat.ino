// DHT22 smart thermostat: 16x2 LCD + heater/fan relays (LEDs)
// Up/Down keys change the set point; the heater runs below it, the fan above it (0.5 C hysteresis).
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <DHT.h>

DHT dht(27, DHT22);
LiquidCrystal_I2C lcd(0x27, 16, 2);
const int UP_PIN = 13, DOWN_PIN = 14, HEAT_PIN = 25, FAN_PIN = 26;
float setpoint = 22.0;
bool heating = false, cooling = false;

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

bool pressed(int pin, bool &was) { bool b = digitalRead(pin); bool p = was && !b; was = b; return p; }

void show(float t, float h) {
  char row[17];
  if (isnan(t)) snprintf(row, sizeof row, "Sensor error!   ");
  else snprintf(row, sizeof row, "%5.1f%cC  %3.0f%%RH ", t, (char)0xDF, h);
  put(0, row);
  snprintf(row, sizeof row, "Set %4.1f %s%c", setpoint, heating ? " HEAT " : cooling ? " COOL " : " idle ", heating ? 0x7E : cooling ? 0x7F : ' ');
  put(1, row);
}

void setup() {
  Serial.begin(115200);
  pinMode(UP_PIN, INPUT_PULLUP); pinMode(DOWN_PIN, INPUT_PULLUP);
  pinMode(HEAT_PIN, OUTPUT); pinMode(FAN_PIN, OUTPUT);
  dht.begin();
  lcd.init(); lcd.backlight();
  put(0, "DHT22 thermostat"); put(1, "  reading...    ");
  Serial.println("Thermostat: Up/Down = set point; drag the DHT22 sliders to change the room");
}

void loop() {
  static bool wu = true, wd = true;
  static unsigned long lastRead = 0;
  static float t = NAN, h = NAN;
  bool changed = false;
  if (pressed(UP_PIN, wu)) { setpoint += 0.5; changed = true; Serial.printf("set point %.1f\n", setpoint); }
  if (pressed(DOWN_PIN, wd)) { setpoint -= 0.5; changed = true; Serial.printf("set point %.1f\n", setpoint); }
  if (millis() - lastRead >= 2000 || lastRead == 0) {
    lastRead = millis();
    t = dht.readTemperature(); h = dht.readHumidity();
    if (!isnan(t)) {
      if (t < setpoint - 0.5) heating = true; else if (t >= setpoint) heating = false;
      if (t > setpoint + 0.5) cooling = true; else if (t <= setpoint) cooling = false;
      Serial.printf("T=%.1f C  RH=%.1f %%  set %.1f  -> %s\n", t, h, setpoint, heating ? "HEAT" : cooling ? "COOL" : "idle");
    } else Serial.println("DHT22 read failed");
    changed = true;
  }
  digitalWrite(HEAT_PIN, heating); digitalWrite(FAN_PIN, cooling);
  if (changed) show(t, h);
  delay(20);
}
