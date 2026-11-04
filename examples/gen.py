import re
src='/workspace/esp32-remote/sim-site/js/examples.js'
s=open(src).read()
names=['traffic','reaction','simon','weather','dice','stopwatch','vumeter','morse','snake','pong','level','servo','neoring','lcdclock','thermostat']
def lit(c): return '`'+c.replace('\\','\\\\').replace('`','\\`').replace('${','\\${')+'`'
consts=''.join(f"  const {n.upper()}_INO = {lit(open(f'/workspace/newex/{n}.ino').read())};\n" for n in names)
block='  // ---- BEGIN fun projects ----\n'+consts+open('/workspace/newex/circuits.js').read()+'  // ---- END fun projects ----\n'
s=re.sub(r'  // ---- BEGIN fun projects ----\n.*?  // ---- END fun projects ----\n','',s,flags=re.S)
s=s.replace("  const LIST = [", block+"  const LIST = [",1)
titles=[('traffic','Traffic light + pedestrian button'),('reaction','Reaction-time game (OLED)'),('simon','Simon memory game'),('weather','OLED weather station (BME280)'),('dice','Electronic dice (OLED + shake)'),('stopwatch','OLED stopwatch with laps'),('vumeter','LED bar-graph VU meter'),('morse','Morse code transceiver'),('snake','Snake game (OLED)'),('pong','Pong vs the ESP32 (OLED + pot)'),('level','Bubble spirit level (MPU6050)'),('servo','Servo knob + radar sweep'),('neoring','NeoPixel ring light show'),('lcdclock','16×2 LCD clock + menu'),('thermostat','DHT22 thermostat (LCD)')]
lst=', '.join(f"['{k}', '🎮 {t}']" if k in('reaction','simon','snake','pong','dice') else f"['{k}', '★ {t}']" for k,t in titles)
s=re.sub(r"\['remote', 'Wi-Fi/IR TV Remote'\], (?:\[.*?\], )*\['blank', 'Blank'\]", "['remote', 'Wi-Fi/IR TV Remote'], "+lst+", ['blank', 'Blank']", s)
open(src,'w').write(s)
