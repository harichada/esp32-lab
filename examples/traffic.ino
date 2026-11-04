// Traffic light with pedestrian crossing.
// Car lights: red D27, yellow D26, green D25.  Pedestrian: WALK (green) D33, DON'T WALK (red) D32.
// Request button on D14 (to GND, internal pull-up).  Buzzer on D4 ticks while it's safe to cross.
const int CAR_R = 27, CAR_Y = 26, CAR_G = 25, PED_G = 33, PED_R = 32, BTN = 14, BUZ = 4;

enum State { CARS_GO, CARS_YELLOW, ALL_RED, WALK, WALK_FLASH, ALL_RED2, RED_YELLOW };
const char *NAMES[] = { "cars GO", "cars YELLOW", "all red", "WALK", "walk ending (flashing)", "all red", "red+yellow (get ready)" };
const unsigned long DUR[] = { 4000, 1500, 1000, 4000, 2500, 1000, 800 };   // ms per state (CARS_GO is the minimum green)

State st = CARS_GO;
unsigned long since = 0;
bool request = false;

void lights(bool r, bool y, bool g, bool pg, bool pr) {
  digitalWrite(CAR_R, r); digitalWrite(CAR_Y, y); digitalWrite(CAR_G, g);
  digitalWrite(PED_G, pg); digitalWrite(PED_R, pr);
}

void enter(State s) {
  st = s; since = millis();
  Serial.printf("[%6lu ms] %s\n", since, NAMES[s]);
  switch (s) {
    case CARS_GO:     lights(0, 0, 1, 0, 1); break;
    case CARS_YELLOW: lights(0, 1, 0, 0, 1); break;
    case ALL_RED:     lights(1, 0, 0, 0, 1); break;
    case WALK:        lights(1, 0, 0, 1, 0); request = false; break;
    case WALK_FLASH:  lights(1, 0, 0, 1, 0); break;
    case ALL_RED2:    lights(1, 0, 0, 0, 1); noTone(BUZ); break;
    case RED_YELLOW:  lights(1, 1, 0, 0, 1); break;
  }
}

void setup() {
  Serial.begin(115200);
  for (int p : { CAR_R, CAR_Y, CAR_G, PED_G, PED_R }) pinMode(p, OUTPUT);
  pinMode(BTN, INPUT_PULLUP);
  Serial.println("Traffic light ready - press the WALK button (key w)");
  enter(CARS_GO);
}

void loop() {
  unsigned long t = millis() - since;
  if (digitalRead(BTN) == LOW && !request && st <= CARS_YELLOW) {
    request = true;
    Serial.println("  pedestrian request accepted - WAIT");
    tone(BUZ, 1500, 60);
  }
  switch (st) {
    case CARS_GO:     if (request && t >= DUR[st]) enter(CARS_YELLOW); break;
    case CARS_YELLOW: if (t >= DUR[st]) enter(ALL_RED); break;
    case ALL_RED:     if (t >= DUR[st]) enter(WALK); break;
    case WALK:
      if ((t / 250) % 2 == 0) tone(BUZ, 2000); else noTone(BUZ);   // fast "tick-tock" crossing signal
      if (t >= DUR[st]) enter(WALK_FLASH);
      break;
    case WALK_FLASH: {
      bool on = (t / 300) % 2 == 0;
      digitalWrite(PED_G, on);
      if (on) tone(BUZ, 1000); else noTone(BUZ);
      if (t >= DUR[st]) enter(ALL_RED2);
      break;
    }
    case ALL_RED2:   if (t >= DUR[st]) enter(RED_YELLOW); break;
    case RED_YELLOW: if (t >= DUR[st]) enter(CARS_GO); break;
  }
  delay(10);
}
