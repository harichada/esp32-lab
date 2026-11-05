#include <WiFi.h>
void setup(){Serial.begin(115200);WiFi.begin("SIM-GUEST","");
 while(WiFi.status()!=WL_CONNECTED){delay(200);Serial.print(".");}
 Serial.print("\nIP=");Serial.println(WiFi.localIP());}
void loop(){delay(1000);}
