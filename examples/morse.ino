// Morse code transceiver.
// TX: type text in the Serial tab and press Enter - it is keyed out on the LED (D25) and buzzer (D26).
// RX: tap the key (key m, D14) - short = dot, long = dash - and the decoded letters print to Serial.
const int LED = 25, BUZ = 26, KEY = 14, UNIT = 80;   // 80 ms dot = 15 WPM
const char *CODE[] = { ".-", "-...", "-.-.", "-..", ".", "..-.", "--.", "....", "..", ".---", "-.-", ".-..", "--",
                       "-.", "---", ".--.", "--.-", ".-.", "...", "-", "..-", "...-", ".--", "-..-", "-.--", "--.." };
const char *DIGITS[] = { "-----", ".----", "..---", "...--", "....-", ".....", "-....", "--...", "---..", "----." };

const char *encode(char c) {
  c = toupper(c);
  if (c >= 'A' && c <= 'Z') return CODE[c - 'A'];
  if (c >= '0' && c <= '9') return DIGITS[c - '0'];
  return nullptr;
}
char decode(const String &s) {
  for (int i = 0; i < 26; i++) if (s == CODE[i]) return 'A' + i;
  for (int i = 0; i < 10; i++) if (s == DIGITS[i]) return '0' + i;
  return '?';
}
void keyOut(int units) { digitalWrite(LED, HIGH); tone(BUZ, 700); delay(units * UNIT); digitalWrite(LED, LOW); noTone(BUZ); delay(UNIT); }

void send(const String &msg) {
  Serial.printf("TX \"%s\"\n   ", msg.c_str());
  for (char c : msg) {
    if (c == ' ') { Serial.print("/ "); delay(UNIT * 4); continue; }
    const char *m = encode(c); if (!m) continue;
    Serial.printf("%s ", m);
    for (const char *p = m; *p; p++) keyOut(*p == '.' ? 1 : 3);
    delay(UNIT * 2);
  }
  Serial.println("\nTX done");
}

String line, sym, rxWord;
unsigned long downAt = 0, upAt = 0; bool wasDown = false;

void setup() {
  Serial.begin(115200);
  pinMode(LED, OUTPUT); pinMode(KEY, INPUT_PULLUP);
  Serial.println("Morse transceiver: type a message + Enter to send; tap key m to receive");
  send("SOS");
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r' || c == '\n') { if (line.length()) { send(line); line = ""; } }
    else line += c;
  }
  bool down = digitalRead(KEY) == LOW; unsigned long now = millis();
  if (down && !wasDown) { downAt = now; digitalWrite(LED, HIGH); tone(BUZ, 600); }
  if (!down && wasDown) {
    digitalWrite(LED, LOW); noTone(BUZ);
    sym += (now - downAt) < UNIT * 2.5 ? '.' : '-'; upAt = now;
  }
  if (!down && sym.length() && now - upAt > UNIT * 5) {     // letter gap
    char c = decode(sym); rxWord += c; Serial.printf("RX %s -> %c\n", sym.c_str(), c); sym = "";
  }
  if (!down && !sym.length() && rxWord.length() && now - upAt > UNIT * 14) { Serial.printf("RX rxWord: %s\n", rxWord.c_str()); rxWord = ""; }
  wasDown = down;
  delay(5);
}
