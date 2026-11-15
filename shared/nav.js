// An on-screen pad for turning the camera, for anyone who finds dragging hard. Each world calls
// NavPad.attach once its OrbitControls exist. The pad sits at the bottom right of the scene:
// the side arrows take the camera around what it looks at, up and down raise and lower it, + and - zoom, and the house goes back
// to the world's first view. Hold a button to keep going. With a pad button or the scene in focus,
// the arrow keys, + and - do the same, and Home (or 0) goes back.
// The button between - and + hides the pad, leaving one button that shows it again. This browser
// keeps the choice, for every world. With the pad hidden, the keys still work on the scene.
//
// It moves the camera the way a drag does, then lets the controls apply the world's own limits,
// and it tells the controls a move started, so the world stops its opening glide or a follow.
(function () {
  'use strict';
  const TURN_PER_SECOND = 1.4;
  const ZOOM_PER_SECOND = 1.9;
  const KEY_PRESS_SECONDS = 0.18;

  const CSS = `
.navpad { position: absolute; right: 12px; bottom: 12px; z-index: 5; display: grid; gap: 4px;
  grid-template-columns: repeat(3, 34px); grid-template-rows: repeat(3, 34px) 34px;
  grid-template-areas: ". up ." "left home right" ". down ." "out toggle in";
  padding: 6px; border-radius: 10px; background: rgba(12, 14, 18, 0.62); }
.navpad button { all: unset; box-sizing: border-box; display: grid; place-items: center; width: 34px; height: 34px;
  border-radius: 7px; background: rgba(255, 255, 255, 0.1); color: #f4f1ea; cursor: pointer; touch-action: none;
  -webkit-user-select: none; user-select: none; }
.navpad button:hover { background: rgba(255, 255, 255, 0.2); }
.navpad button:active, .navpad button.held { background: rgba(255, 255, 255, 0.32); }
.navpad button:focus-visible { outline: 2px solid #f0c25e; outline-offset: 1px; }
.navpad svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.navpad button[data-pad="toggle"] { background: transparent; color: rgba(244, 241, 234, 0.7); }
.navpad button[data-pad="toggle"]:hover { background: rgba(255, 255, 255, 0.14); color: #f4f1ea; }
.navpad.navpad-hidden { grid-template-columns: 34px; grid-template-rows: 34px; grid-template-areas: "toggle"; padding: 4px; }
.navpad.navpad-hidden button[data-dir] { display: none; }
.navpad.navpad-hidden button[data-pad="toggle"] { background: rgba(255, 255, 255, 0.1); color: #f4f1ea; }
@media (pointer: coarse) { .navpad { grid-template-columns: repeat(3, 42px); grid-template-rows: repeat(4, 42px); } .navpad button { width: 42px; height: 42px; }
  .navpad.navpad-hidden { grid-template-columns: 42px; grid-template-rows: 42px; } }
`;
  const ICON = {
    up: '<path d="M5 14l7-7 7 7"/>', down: '<path d="M5 10l7 7 7-7"/>',
    left: '<path d="M14 5l-7 7 7 7"/>', right: '<path d="M10 5l7 7-7 7"/>',
    in: '<path d="M12 5v14M5 12h14"/>', out: '<path d="M5 12h14"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6.5 9.5V19h11V9.5"/>',
    hide: '<path d="M6 9l6 6 6-6"/>',
    show: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'
  };
  const HIDDEN_KEY = 'navpad-hidden';
  function keptHidden() { try { return localStorage.getItem(HIDDEN_KEY) === '1'; } catch (e) { return false; } }
  function keepHidden(on) { try { if (on) localStorage.setItem(HIDDEN_KEY, '1'); else localStorage.removeItem(HIDDEN_KEY); return true; } catch (e) { return false; } }
  const BUTTONS = [
    ['up', 'Look from higher up'], ['left', 'Go around to the left'], ['home', 'Back to the first view'],
    ['right', 'Go around to the right'], ['down', 'Look from lower down'], ['out', 'Zoom out'], ['in', 'Zoom in']
  ];
  const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', '+': 'in', '=': 'in', '-': 'out', _: 'out', Home: 'home', 0: 'home' };
  const pads = [];

  function attach(opts) {
    const { stage, canvas, controls, camera, home } = opts;
    if (!stage || !controls || !camera || !window.THREE) return null;
    if (!document.getElementById('navpad-css')) {
      const st = document.createElement('style'); st.id = 'navpad-css'; st.textContent = CSS; document.head.appendChild(st);
    }
    const pad = document.createElement('div');
    pad.className = 'navpad'; pad.setAttribute('role', 'group'); pad.setAttribute('aria-label', 'Move the view');
    const offset = new THREE.Vector3(), sph = new THREE.Spherical();

    function move(dir, secs) {
      if (dir === 'home') { home(); controls.dispatchEvent({ type: 'start' }); controls.dispatchEvent({ type: 'end' }); return; }
      offset.copy(camera.position).sub(controls.target);
      sph.setFromVector3(offset);
      if (dir === 'left') sph.theta -= TURN_PER_SECOND * secs;
      if (dir === 'right') sph.theta += TURN_PER_SECOND * secs;
      if (dir === 'up') sph.phi -= TURN_PER_SECOND * 0.6 * secs;
      if (dir === 'down') sph.phi += TURN_PER_SECOND * 0.6 * secs;
      if (dir === 'in') sph.radius /= Math.pow(ZOOM_PER_SECOND, secs);
      if (dir === 'out') sph.radius *= Math.pow(ZOOM_PER_SECOND, secs);
      sph.makeSafe();
      offset.setFromSpherical(sph);
      camera.position.copy(controls.target).add(offset);
      camera.lookAt(controls.target);
      controls.update();
    }

    let held = null, last = 0, raf = 0;
    function tick(now) {
      if (!held) return;
      move(held.dir, Math.min(0.25, (now - last) / 1000)); last = now;
      raf = requestAnimationFrame(tick);
    }
    function start(btn, dir) {
      stop();
      held = { btn, dir }; btn.classList.add('held'); last = performance.now();
      controls.dispatchEvent({ type: 'start' });
      if (dir === 'home') { move('home'); return; }
      move(dir, 1 / 60);
      raf = requestAnimationFrame(tick);
    }
    function stop() {
      if (!held) return;
      if (held.dir !== 'home') move(held.dir, Math.min(0.5, (performance.now() - last) / 1000));
      held.btn.classList.remove('held'); held = null; cancelAnimationFrame(raf);
      controls.dispatchEvent({ type: 'end' });
    }

    const byDir = {};
    BUTTONS.forEach(([dir, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.dir = dir; b.style.gridArea = dir;
      b.setAttribute('aria-label', label); b.title = label;
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[dir] + '</svg>';
      b.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; e.preventDefault(); b.setPointerCapture && b.setPointerCapture(e.pointerId); start(b, dir); });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => b.addEventListener(t, stop));
      b.addEventListener('click', (e) => { if (e.detail === 0) { controls.dispatchEvent({ type: 'start' }); move(dir, KEY_PRESS_SECONDS); controls.dispatchEvent({ type: 'end' }); } });
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      byDir[dir] = b; pad.appendChild(b);
    });
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.dataset.pad = 'toggle'; toggle.style.gridArea = 'toggle';
    function setHidden(on, keep) {
      pad.classList.toggle('navpad-hidden', on);
      const label = on ? 'Show the pad' : 'Hide the pad';
      toggle.setAttribute('aria-label', label); toggle.title = label; toggle.setAttribute('aria-expanded', String(!on));
      toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[on ? 'show' : 'hide'] + '</svg>';
      if (on && held) stop();
      if (keep) keepHidden(on);
    }
    toggle.addEventListener('click', () => setHidden(!pad.classList.contains('navpad-hidden'), true));
    pad.appendChild(toggle);
    setHidden(keptHidden(), false);
    ['pointerdown', 'pointerup', 'click', 'wheel'].forEach((t) => pad.addEventListener(t, (e) => e.stopPropagation()));
    stage.appendChild(pad);

    function onKey(e) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const dir = KEYS[e.key];
      if (!dir) return;
      e.preventDefault();
      controls.dispatchEvent({ type: 'start' });
      move(dir, KEY_PRESS_SECONDS);
      controls.dispatchEvent({ type: 'end' });
    }
    pad.addEventListener('keydown', (e) => { if (e.key !== 'Enter' && e.key !== ' ') onKey(e); });
    if (canvas) {
      if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
      canvas.addEventListener('keydown', onKey);
    }

    const handle = {
      el: pad, press: (dir, secs) => move(dir, secs === undefined ? KEY_PRESS_SECONDS : secs),
      hidden: () => pad.classList.contains('navpad-hidden'), setHidden: (on) => setHidden(!!on, true),
      angles: () => { offset.copy(camera.position).sub(controls.target); sph.setFromVector3(offset); return { theta: sph.theta, phi: sph.phi, radius: sph.radius }; }
    };
    pads.push(handle);
    return handle;
  }

  window.NavPad = { attach, pads };
})();
