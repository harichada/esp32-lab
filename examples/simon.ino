// Simon says: repeat the growing colour sequence.
// LEDs: red D27, green D26, blue D25, yellow D33.  Buttons (to GND, pull-ups): D13, D14, D18, D19 = keys 1 2 3 4.
// Buzzer on D23 plays each colour's note.
const int LED[4] = { 27, 26, 25, 33 };
const int KEY[4] = { 13, 14, 18, 19 };
const int NOTE[4] = { 330, 440, 554, 659 };      // E4 A4 C#5 E5 - the classic Simon chord
const char *COL[4] = { "red", "green", "blue", "yellow" };
const int BUZ = 23, MAXLEN = 32;
int seq[MAXLEN], len = 0, best = 0;

void flash(int i, int ms) {
  digitalWrite(LED[i], HIGH); tone(BUZ, NOTE[i]);
  delay(ms);
  digitalWrite(LED[i], LOW); noTone(BUZ);
}

int readKey(unsigned long timeout) {             // -1 on timeout
  unsigned long t0 = millis();
  while (millis() - t0 < timeout) {
    for (int i = 0; i < 4; i++) if (digitalRead(KEY[i]) == LOW) {
      digitalWrite(LED[i], HIGH); tone(BUZ, NOTE[i]);
      while (digitalRead(KEY[i]) == LOW) delay(5);
      delay(40); digitalWrite(LED[i], LOW); noTone(BUZ);
      return i;
    }
    delay(5);
  }
  return -1;
}

void gameOver() {
  Serial.printf("GAME OVER - you reached level %d (best %d)\n", len - 1, best);
  tone(BUZ, 150); for (int k = 0; k < 4; k++) digitalWrite(LED[k], HIGH);
  delay(800); noTone(BUZ);
  for (int k = 0; k < 4; k++) digitalWrite(LED[k], LOW);
  delay(600);
  len = 0;
  Serial.println("press any button to play again");
  readKey(600000);
  delay(400);
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 4; i++) { pinMode(LED[i], OUTPUT); pinMode(KEY[i], INPUT_PULLUP); }
  randomSeed(esp_random());
  Serial.println("SIMON - watch, listen, repeat. Keys 1-4 (or click the buttons).");
  for (int r = 0; r < 2; r++) for (int i = 0; i < 4; i++) flash(i, 90);   // attract sweep
  delay(500);
}

void loop() {
  if (len == MAXLEN) { Serial.println("PERFECT GAME! You beat all 32 levels."); for (int k = 0; k < 12; k++) flash(k % 4, 70); len = 0; }
  seq[len++] = random(4);
  Serial.printf("level %d: ", len);
  int speed = len < 6 ? 420 : len < 12 ? 320 : 230;
  for (int i = 0; i < len; i++) { flash(seq[i], speed); Serial.printf("%s ", COL[seq[i]]); delay(speed / 3); }
  Serial.println();
  for (int i = 0; i < len; i++) {
    int k = readKey(5000);
    if (k != seq[i]) {
      Serial.printf(k < 0 ? "  too slow!\n" : "  wrong: pressed %s, expected %s\n", k < 0 ? "" : COL[k], COL[seq[i]]);
      gameOver();
      return;
    }
  }
  if (len > best) best = len;
  Serial.printf("  correct! score %d\n", len);
  delay(700);
}
