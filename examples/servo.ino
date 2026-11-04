// Pot-controlled servo + radar sweep  (ESP32Servo, real LEDC 50 Hz PWM)
// Turn the knob to aim the SG90. Press S to toggle the automatic radar sweep.
#include <ESP32Servo.h>

const int SERVO_PIN = 13, POT_PIN = 34, MODE_PIN = 14, LED_PIN = 25;
Servo arm;
bool sweep = false;
int angle = 90, dir = 1, lastShown = -1;
unsigned long lastStep = 0;

void setup() {
  Serial.begin(115200);
  pinMode(MODE_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
  arm.setPeriodHertz(50);
  arm.attach(SERVO_PIN, 544, 2400);   // SG90 pulse range
  Serial.println("Servo ready: knob = angle, S = radar sweep");
}

void loop() {
  static bool was = HIGH;
  bool b = digitalRead(MODE_PIN);
  if (was == HIGH && b == LOW) {
    sweep = !sweep;
    Serial.println(sweep ? "mode: RADAR SWEEP" : "mode: KNOB");
    delay(30);
  }
  was = b;
  digitalWrite(LED_PIN, sweep);

  if (sweep) {
    if (millis() - lastStep >= 20) {
      lastStep = millis();
      angle += dir * 3;
      if (angle >= 180) { angle = 180; dir = -1; }
      if (angle <= 0) { angle = 0; dir = 1; }
    }
  } else {
    angle = map(analogRead(POT_PIN), 0, 4095, 0, 180);
  }
  arm.write(angle);
  if (abs(angle - lastShown) >= 10 || (angle != lastShown && (angle == 0 || angle == 180))) {
    lastShown = angle;
    Serial.printf("angle %3d deg  pulse %4d us\n", angle, arm.readMicroseconds());
  }
  delay(10);
}
