// 8-LED bar-graph VU meter. Turn the pot (D34) to set the level, or flip the slide switch (D4)
// to MUSIC mode for a simulated beat. Peak-hold dot falls back slowly, like a real meter.
const int LEDS[8] = { 13, 14, 27, 26, 25, 33, 32, 23 };   // 5 green, 2 yellow, 1 red
const int POT = 34, MODE_SW = 4;
float level = 0; int peak = 0; unsigned long peakT = 0;

void setup() {
  Serial.begin(115200);
  for (int p : LEDS) pinMode(p, OUTPUT);
  pinMode(MODE_SW, INPUT_PULLUP);           // switch to GND = POT mode, open = MUSIC mode
  analogReadResolution(12);
  for (int i = 0; i < 8; i++) { digitalWrite(LEDS[i], HIGH); delay(60); }   // power-on sweep
  for (int i = 7; i >= 0; i--) { digitalWrite(LEDS[i], LOW); delay(40); }
  Serial.println("VU meter: turn the pot, or flip the switch for MUSIC mode");
}

void loop() {
  bool music = digitalRead(MODE_SW) == HIGH;
  float in;
  if (music) {                                   // kick drum every 500 ms + wobbling melody
    unsigned long t = millis();
    float kick = exp(-(t % 500) / 90.0);
    in = constrain(0.25 + 0.65 * kick + 0.15 * sin(t / 130.0) * sin(t / 47.0) + random(-6, 7) / 100.0, 0, 1);
  } else in = analogRead(POT) / 4095.0;
  level = in > level ? in : level * 0.85 + in * 0.15;   // fast attack, slow release
  int n = round(level * 8);
  if (n >= peak) { peak = n; peakT = millis(); }
  else if (millis() - peakT > 600 && peak > 0) { peak--; peakT = millis() - 450; }
  for (int i = 0; i < 8; i++) digitalWrite(LEDS[i], i < n || (i == peak - 1 && peak > 0));
  static unsigned long lastLog; static int lastN = -1;
  if (n != lastN && millis() - lastLog > 250) {
    lastLog = millis(); lastN = n;
    char bar[9]; for (int i = 0; i < 8; i++) bar[i] = i < n ? '#' : (i == peak - 1 ? '|' : '.'); bar[8] = 0;
    Serial.printf("%s [%s] %3d%%\n", music ? "MUSIC" : "POT  ", bar, (int)(level * 100));
  }
  delay(20);
}
