(function () {
  var b = document.getElementById('bForce2d');
  if (!b) return;
  b.addEventListener('click', function () {
    try { clStorage.local.removeItem('esp32lab.view'); } catch (e) { /* keep going */ }
    document.body.classList.remove('view3d', 'viewsch');
    var c = document.getElementById('stage3d');
    if (c) { c.classList.remove('on'); c.style.pointerEvents = 'none'; }
    var s = document.getElementById('stageSch');
    if (s) s.classList.remove('on');
    if (window.app && app.cmd && app.cmd.view2d) app.cmd.view2d();
  });
})();
