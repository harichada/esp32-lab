#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
void setup(){ Serial.begin(115200); Wire.begin(); oled.begin(SSD1306_SWITCHCAPVCC,0x3C); }
void loop(){ unsigned long t0=micros(); for(int i=0;i<10;i++){ oled.clearDisplay(); oled.fillCircle(i*10,30,8,1); oled.display(); } unsigned long t1=micros();
 unsigned long t2=micros(); for(volatile long i=0;i<200000;i++); unsigned long t3=micros();
 Serial.printf("10 frames %lu us, busy %lu us, millis %lu\n", t1-t0, t3-t2, millis()); }
