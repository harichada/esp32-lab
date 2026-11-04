// OLED weather station: BME280 (temperature / humidity / pressure) on an SSD1306.
// Key n (D14) cycles pages: overview -> temperature graph -> pressure graph -> forecast.
// Move the BME280 sliders in the Inspector while it runs and watch the graphs and the forecast react.
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_BME280.h>

const int BTN = 14;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_BME280 bme;
const int N = 100;
float histT[N], histP[N]; int count = 0, page = 0;
unsigned long lastSample = 0;
bool lastBtn = HIGH;

void push(float *h, float v) { memmove(h, h + 1, (N - 1) * sizeof(float)); h[N - 1] = v; }

void graph(const char *title, float *h, const char *unit) {
  int n = min(count, N); float lo = 1e9, hi = -1e9;
  for (int i = N - n; i < N; i++) { lo = min(lo, h[i]); hi = max(hi, h[i]); }
  if (hi - lo < 1) { float m = (hi + lo) / 2; lo = m - 0.5; hi = m + 0.5; }
  oled.setTextSize(1); oled.setCursor(0, 0); oled.printf("%s %.1f%s", title, h[N - 1], unit);
  oled.setCursor(104, 12); oled.printf("%.0f", hi); oled.setCursor(104, 56); oled.printf("%.0f", lo);
  oled.drawRect(0, 11, 102, 53, SSD1306_WHITE);
  for (int i = N - n + 1; i < N; i++) {
    int x0 = 1 + (i - 1), x1 = 1 + i;
    int y0 = 62 - (int)((h[i - 1] - lo) / (hi - lo) * 49), y1 = 62 - (int)((h[i] - lo) / (hi - lo) * 49);
    oled.drawLine(x0, y0, x1, y1, SSD1306_WHITE);
  }
}

const char *forecast(float dp) {              // pressure tendency over the stored history (hPa)
  if (dp > 1.5) return "Sunny";
  if (dp > 0.5) return "Fair, drier";
  if (dp < -1.5) return "Storm alert";
  if (dp < -0.5) return "Rain likely";
  return "Steady";
}

void setup() {
  Serial.begin(115200);
  pinMode(BTN, INPUT_PULLUP);
  Wire.begin();
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) Serial.println("SSD1306 not found");
  if (!bme.begin(0x76)) Serial.println("BME280 not found - check wiring");
  delay(100); bme.readTemperature();          // let the first conversion finish; discard it
  oled.setTextColor(SSD1306_WHITE);
  Serial.println("Weather station: key n changes page");
}

void loop() {
  bool b = digitalRead(BTN);
  bool flip = (b == LOW && lastBtn == HIGH);
  if (flip) { page = (page + 1) % 4; Serial.printf("page %d\n", page); }
  lastBtn = b;
  static float t, h, p;
  bool sample = millis() - lastSample >= 1000 || !count;
  if (sample) {
    lastSample = millis();
    t = bme.readTemperature(); h = bme.readHumidity(); p = bme.readPressure() / 100.0;
    if (!count) for (int i = 0; i < N; i++) { histT[i] = t; histP[i] = p; }
    push(histT, t); push(histP, p); count++;
  }
  if (sample || flip) {
    if (sample && count % 5 == 1) Serial.printf("T=%.1f C  RH=%.0f %%  P=%.1f hPa  -> %s\n", t, h, p, forecast(histP[N - 1] - histP[N - min(count, N)]));
    oled.clearDisplay();
    if (page == 0) {
      oled.setTextSize(3); oled.setCursor(0, 0); oled.printf("%.1f", t);
      oled.setTextSize(1); oled.print(" o"); oled.setTextSize(2); oled.print("C");
      oled.setTextSize(1);
      oled.setCursor(0, 30); oled.printf("RH %3.0f%%", h);
      oled.drawRect(52, 30, 76, 7, SSD1306_WHITE); oled.fillRect(54, 32, (int)(h * 0.72), 3, SSD1306_WHITE);
      oled.setCursor(0, 42); oled.printf("P  %.1f hPa", p);
      const char *feel = t > 30 ? (h > 60 ? "Hot & sticky" : "Hot") : t < 10 ? "Cold" : (h < 30 ? "Pleasant, dry" : h > 70 ? "Mild, humid" : "Comfortable");
      oled.setCursor(0, 54); oled.print(feel);
    } else if (page == 1) graph("Temp", histT, "C");
    else if (page == 2) graph("Press", histP, "hPa");
    else {
      float dp = histP[N - 1] - histP[N - min(count, N)];
      oled.setTextSize(1); oled.setCursor(0, 0); oled.print("FORECAST");
      oled.drawFastHLine(0, 10, 128, SSD1306_WHITE);
      int cx = 24, cy = 36;
      if (dp > 0.5) { oled.fillCircle(cx, cy, 10, SSD1306_WHITE); for (int a = 0; a < 360; a += 45) oled.drawLine(cx + 13 * cos(a * DEG_TO_RAD), cy + 13 * sin(a * DEG_TO_RAD), cx + 17 * cos(a * DEG_TO_RAD), cy + 17 * sin(a * DEG_TO_RAD), SSD1306_WHITE); }
      else { oled.fillCircle(cx - 6, cy, 8, SSD1306_WHITE); oled.fillCircle(cx + 5, cy - 4, 10, SSD1306_WHITE); oled.fillRect(cx - 14, cy, 30, 8, SSD1306_WHITE);
             if (dp < -0.5) for (int i = 0; i < 4; i++) oled.drawLine(cx - 10 + i * 7, cy + 12, cx - 13 + i * 7, cy + 18, SSD1306_WHITE); }
      oled.setCursor(50, 22); oled.print(forecast(dp));
      oled.setCursor(50, 40); oled.printf("%+.1f hPa", dp);
      oled.setCursor(50, 50); oled.print("trend");
    }
    oled.display();
  }
  delay(20);
}
