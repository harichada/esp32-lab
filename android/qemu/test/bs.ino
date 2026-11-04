void setup(){Serial.begin(115200);pinMode(2,OUTPUT);}
int n=0;void loop(){digitalWrite(2,n&1);Serial.printf("BLINK %d led=%d\n",n,n&1);n++;delay(500);}
