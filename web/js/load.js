/* Insert the lab scripts after the largest paint, in source order.
   A request that finishes before that paint is on the LCP path. async is false
   so the scripts stay ordered. The timer covers a document that never paints. */
(function () {
  var files = [
    'js/storage.js?v=1',
    'js/boot-theme.js?v=90',
    'js/boot-view.js?v=91',
    'js/force2d.js?v=92',
    'js/solver.js?v=40',
    'js/parts.js?v=48',
    'js/parts-art.js?v=100',
    'js/scope.js?v=40',
    'js/sim.js?v=40',
    'js/remote_logic.js?v=40',
    'js/devices.js?v=40',
    'js/netlog.js?v=41',
    'js/i2cdev.js?v=40',
    'js/spidev.js?v=40',
    'js/jssketch.js?v=46',
    'js/examples.js?v=42',
    'js/basic.js?v=41',
    'js/bom.js?v=41',
    'js/parts/registry.js?v=40',
    'js/parts/sensors.js?v=40',
    'js/parts/displays.js?v=40',
    'js/parts/examples-sensors-displays.js?v=40',
    'js/parts/ics.js?v=40',
    'js/parts/passives.js?v=41',
    'js/parts/examples-ics.js?v=40',
    'js/parts/hwkit.js?v=40',
    'js/parts/actuators.js?v=40',
    'js/parts/power.js?v=40',
    'js/parts/semis.js?v=40',
    'js/parts/examples-actuators.js?v=40',
    'js/projects.js?v=43',
    'js/pinch.js?v=62',
    'js/editor.js?v=66',
    'js/codeview.js?v=40',
    'js/ui.js?v=63',
    'js/netlist.js?v=51',
    'js/schematic.js?v=66',
    'js/viewchrome.js?v=1',
    'js/app.js?v=86',
    'js/mobile.js?v=98'
  ];
  var lateCss = ['css/app.css?v=97', 'css/theme-late.css?v=103', 'css/mobile.css?v=96'];
  function start() {
    for (var n = 0; n < lateCss.length; n++) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = lateCss[n];
      document.head.appendChild(link);
    }
    for (var i = 0; i < files.length; i++) {
      var s = document.createElement('script');
      s.src = files[i];
      s.async = false;
      document.body.appendChild(s);
    }
  }
  var started = false;
  function once() {
    if (started) return;
    started = true;
    start();
  }
  // Start after the largest paint so those requests are not on the LCP path.
  // The timer covers a document that never reports a paint.
  try {
    var paints = new PerformanceObserver(function () {
      paints.disconnect();
      setTimeout(once, 0);
    });
    paints.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) { /* the timer below still starts the page */ }
  setTimeout(once, 200);
})();
