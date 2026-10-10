// 3D-світ карти на Three.js: процедурні текстури, стіни, ящики, гравці, дим, вогонь, ефекти.
// Координати: клітинка (x, y) → світ (x + 0.5, 0, y + 0.5). Одна клітинка = 1 одиниця.
import * as THREE from 'three';

const WALL_H = 1.7;
const CRATE_H = 0.85;
const TEAM = {
  T: { cloth: 0xb8925a, vest: 0xd9822b, dark: 0x6b4a22 },
  CT: { cloth: 0x2f4c6e, vest: 0x4e8fd0, dark: 0x1b2c40 },
};

/* ---------------- процедурні текстури ---------------- */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

function speckle(g, w, h, n, r, colors, rand, alpha = 0.18) {
  for (let i = 0; i < n; i++) {
    g.globalAlpha = alpha * (0.4 + rand());
    g.fillStyle = colors[Math.floor(rand() * colors.length)];
    const s = r * (0.3 + rand());
    g.fillRect(rand() * w, rand() * h, s, s);
  }
  g.globalAlpha = 1;
}

// Пісковикова кладка — безшовна по горизонталі
function wallTexture() {
  const S = 256, c = canvas(S, S), g = c.getContext('2d'), rand = rng(11);
  g.fillStyle = '#c9a774'; g.fillRect(0, 0, S, S);
  const rows = 6, bh = S / rows;
  for (let r = 0; r < rows; r++) {
    const bw = S / 3, off = (r % 2) * bw / 2;
    for (let i = -1; i < 4; i++) {
      const x = i * bw + off, y = r * bh;
      const l = 64 + rand() * 12, sat = 38 + rand() * 12, hue = 34 + rand() * 6;
      g.fillStyle = `hsl(${hue},${sat}%,${l}%)`;
      g.fillRect(x + 2, y + 2, bw - 4, bh - 4);
      // фаска і тінь каменя
      g.fillStyle = 'rgba(255,240,210,.18)'; g.fillRect(x + 2, y + 2, bw - 4, 3);
      g.fillStyle = 'rgba(60,35,10,.18)'; g.fillRect(x + 2, y + bh - 6, bw - 4, 4);
    }
  }
  speckle(g, S, S, 1600, 3, ['#7a5a32', '#e8d3a8', '#a07c4c'], rand, 0.22);
  // вивітрені плями
  for (let i = 0; i < 14; i++) {
    const x = rand() * S, y = rand() * S, rr = 10 + rand() * 30;
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, 'rgba(110,80,40,.18)'); gr.addColorStop(1, 'rgba(110,80,40,0)');
    g.fillStyle = gr; g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  // бруд біля землі (низ текстури = низ стіни)
  const dirt = g.createLinearGradient(0, S * 0.75, 0, S);
  dirt.addColorStop(0, 'rgba(90,60,30,0)'); dirt.addColorStop(1, 'rgba(90,60,30,.35)');
  g.fillStyle = dirt; g.fillRect(0, S * 0.75, S, S * 0.25);
  return tex(c);
}

function roofTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d'), rand = rng(5);
  g.fillStyle = '#b89a6c'; g.fillRect(0, 0, S, S);
  speckle(g, S, S, 900, 3, ['#8c7048', '#d6bf94', '#a3865a'], rand, 0.25);
  for (let i = 0; i < 6; i++) {
    const x = rand() * S, y = rand() * S, rr = 12 + rand() * 24;
    const gr = g.createRadialGradient(x, y, 0, x, y, rr);
    gr.addColorStop(0, 'rgba(120,90,50,.16)'); gr.addColorStop(1, 'rgba(120,90,50,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  return tex(c);
}

function crateTexture() {
  const S = 128, c = canvas(S, S), g = c.getContext('2d'), rand = rng(3);
  g.fillStyle = '#9a6a3a'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 6; i++) {
    g.fillStyle = `hsl(28,${45 + rand() * 10}%,${36 + rand() * 8}%)`;
    g.fillRect(0, i * S / 6 + 1, S, S / 6 - 2);
    g.strokeStyle = 'rgba(40,20,5,.25)';
    for (let k = 0; k < 4; k++) { g.beginPath(); const y = i * S / 6 + 3 + rand() * (S / 6 - 6); g.moveTo(0, y); g.lineTo(S, y + rand() * 4 - 2); g.stroke(); }
  }
  g.fillStyle = '#6b4523';
  g.fillRect(0, 0, S, 14); g.fillRect(0, S - 14, S, 14); g.fillRect(0, 0, 14, S); g.fillRect(S - 14, 0, 14, S);
  g.save(); g.translate(S / 2, S / 2); g.rotate(Math.PI / 4); g.fillRect(-S * 0.7, -7, S * 1.4, 14); g.restore();
  g.fillStyle = '#3a3a3a';
  for (const [x, y] of [[7, 7], [S - 7, 7], [7, S - 7], [S - 7, S - 7]]) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }
  speckle(g, S, S, 300, 2, ['#3b2410', '#c49060'], rand, 0.2);
  return tex(c);
}

function tex(c, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.anisotropy = 4;
  return t;
}

// Підлога всієї карти в одній текстурі: плити, бруківка, бетон, тіні біля стін, літери точок
function floorTexture(grid) {
  const P = 48, W = grid.w * P, H = grid.h * P;
  const c = canvas(W, H), g = c.getContext('2d'), rand = rng(42);
  g.fillStyle = '#2a2219'; g.fillRect(0, 0, W, H);
  for (let y = 0; y < grid.h; y++) for (let x = 0; x < grid.w; x++) {
    const ch = grid.at(x, y);
    if (ch === '#') continue;
    const X = x * P, Y = y * P;
    if (ch === 'T') {
      // бруківка
      g.fillStyle = '#a88a5e'; g.fillRect(X, Y, P, P);
      for (let i = 0; i < 9; i++) {
        const cx = X + (i % 3 + 0.5) * P / 3 + (rand() - 0.5) * 5, cy = Y + (Math.floor(i / 3) + 0.5) * P / 3 + (rand() - 0.5) * 5;
        g.fillStyle = `hsl(${33 + rand() * 6},${30 + rand() * 12}%,${56 + rand() * 10}%)`;
        g.beginPath(); g.ellipse(cx, cy, P / 7.2, P / 7.8, rand() * 3, 0, Math.PI * 2); g.fill();
      }
    } else if (ch === 'C') {
      g.fillStyle = `hsl(36,${14 + rand() * 6}%,${62 + rand() * 6}%)`; g.fillRect(X, Y, P, P);
      g.strokeStyle = 'rgba(60,50,35,.35)'; g.lineWidth = 2; g.strokeRect(X + 1, Y + 1, P - 2, P - 2);
    } else {
      // великі плити 2×2 клітинки
      const slab = ((x >> 1) * 7 + (y >> 1) * 13) % 5;
      g.fillStyle = `hsl(${36 + slab},${44 + slab}%,${63 + slab * 1.2}%)`;
      g.fillRect(X, Y, P, P);
      g.fillStyle = 'rgba(80,55,25,.35)';
      if (x % 2 === 0) g.fillRect(X, Y, 2, P);
      if (y % 2 === 0) g.fillRect(X, Y, P, 2);
      if (ch === 'A' || ch === 'B') { g.fillStyle = 'rgba(150,60,40,.10)'; g.fillRect(X, Y, P, P); }
    }
    // пісок і дрібні камінці
    speckle(g, P, P, 0, 0, [], rand);
    for (let i = 0; i < 40; i++) {
      g.globalAlpha = 0.15 + rand() * 0.2;
      g.fillStyle = rand() < 0.5 ? '#7d5d34' : '#f0dcb0';
      g.fillRect(X + rand() * P, Y + rand() * P, 1 + rand() * 2.5, 1 + rand() * 2.5);
    }
    g.globalAlpha = 1;
    // тріщини
    if (rand() < 0.12) {
      g.strokeStyle = 'rgba(70,45,20,.4)'; g.lineWidth = 1;
      g.beginPath(); let px = X + rand() * P, py = Y + rand() * P; g.moveTo(px, py);
      for (let k = 0; k < 4; k++) { px += (rand() - 0.5) * 18; py += (rand() - 0.5) * 18; g.lineTo(px, py); }
      g.stroke();
    }
    // м'яка тінь біля стін (ambient occlusion)
    const ao = (dx, dy, x0, y0, x1, y1) => {
      if (grid.at(x + dx, y + dy) !== '#') return;
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, 'rgba(40,25,10,.45)'); gr.addColorStop(1, 'rgba(40,25,10,0)');
      g.fillStyle = gr; g.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) || P, Math.abs(y1 - y0) || P);
    };
    ao(-1, 0, X, Y, X + P * 0.35, Y);
    ao(1, 0, X + P, Y, X + P * 0.65, Y);
    ao(0, -1, X, Y, X, Y + P * 0.35);
    ao(0, 1, X, Y + P, X, Y + P * 0.65);
    // нанесений вітром пісок у кутах
    if (grid.at(x, y + 1) === '#' || grid.at(x - 1, y) === '#') {
      g.fillStyle = 'rgba(230,200,140,.25)';
      g.beginPath(); g.ellipse(X + P * 0.2, Y + P * 0.85, P * 0.35, P * 0.12, 0.3, 0, Math.PI * 2); g.fill();
    }
  }
  // літери точок фарбою
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const ch of ['A', 'B']) {
    const ts = grid.tilesOf(ch);
    const cx = (ts.reduce((a, t) => a + t.x, 0) / ts.length + 0.5) * P, cy = (ts.reduce((a, t) => a + t.y, 0) / ts.length + 0.5) * P;
    g.font = `900 ${P * 3.2}px Oswald, Impact, sans-serif`;
    g.fillStyle = 'rgba(170,40,25,.55)';
    g.fillText(ch === 'A' ? 'A' : 'Б', cx, cy);
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 3; g.strokeText(ch === 'A' ? 'A' : 'Б', cx, cy);
  }
  const t = tex(c, false);
  t.anisotropy = 8;
  return t;
}

function softSprite(color, inner = 0.9) {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, color.replace('A', String(inner)));
  gr.addColorStop(0.55, color.replace('A', String(inner * 0.6)));
  gr.addColorStop(1, color.replace('A', '0'));
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return tex(c, false);
}

/* ---------------- світ ---------------- */
export class World3D {
  constructor(container, grid, { mobile } = {}) {
    this.grid = grid;
    this.mobile = mobile;
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = 'gl';
    container.prepend(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xd9c4a0);
    scene.fog = new THREE.Fog(0xd9c4a0, 40, 90);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 200);
    this.view = { tx: grid.w / 2, tz: grid.h / 2, dist: 22, pitch: 1.1, yaw: 0 };
    this.anim = null;

    // світло: тепле сонце + небо
    scene.add(new THREE.HemisphereLight(0xfff1d6, 0x6b5232, 1.35));
    const sun = new THREE.DirectionalLight(0xffe2b0, 2.3);
    sun.position.set(grid.w / 2 - 14, 30, grid.h / 2 + 10);
    sun.target.position.set(grid.w / 2, 0, grid.h / 2);
    sun.castShadow = true;
    const S = mobile ? 1024 : 2048;
    sun.shadow.mapSize.set(S, S);
    const cam = sun.shadow.camera;
    cam.left = -26; cam.right = 26; cam.top = 26; cam.bottom = -26; cam.near = 1; cam.far = 80;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    scene.add(sun, sun.target);

    this.buildMap();
    this.buildOverlay();
    this.players = new Map();
    this.smokeGroup = new THREE.Group(); scene.add(this.smokeGroup);
    this.fireGroup = new THREE.Group(); scene.add(this.fireGroup);
    this.fxGroup = new THREE.Group(); scene.add(this.fxGroup);
    this.fx = [];
    this.smokeKey = ''; this.fireKey = '';
    this.textures = {
      smoke: softSprite('rgba(215,215,212,A)', 0.95),
      fire: softSprite('rgba(255,140,40,A)', 1),
      flash: softSprite('rgba(255,255,235,A)', 1),
      blast: softSprite('rgba(255,120,50,A)', 1),
      scorch: softSprite('rgba(40,20,8,A)', 0.7),
    };
    this.buildBomb();
    this.raycaster = new THREE.Raycaster();
  }

  buildMap() {
    const g = this.grid, scene = this.scene;
    // підлога
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(g.w, g.h),
      new THREE.MeshStandardMaterial({ map: floorTexture(g), roughness: 0.95, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(g.w / 2, 0, g.h / 2);
    floor.receiveShadow = true;
    scene.add(floor);
    // земля навколо карти
    const outside = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0xbfa077, roughness: 1 }));
    outside.rotation.x = -Math.PI / 2; outside.position.set(g.w / 2, -0.02, g.h / 2); outside.receiveShadow = true;
    scene.add(outside);

    // стіни: інстансовані бруски з окремою текстурою боків і даху
    const walls = [];
    for (let y = -1; y <= g.h; y++) for (let x = -1; x <= g.w; x++) if (g.at(x, y) === '#') walls.push([x, y]);
    const wallGeo = new THREE.BoxGeometry(1, WALL_H, 1);
    // розтягуємо UV боків по висоті, щоб кладка не була сплющеною
    const uv = wallGeo.attributes.uv;
    for (const grp of wallGeo.groups) {
      if (grp.materialIndex === 2 || grp.materialIndex === 3) continue;
      for (let i = grp.start; i < grp.start + grp.count; i++) {
        const idx = wallGeo.index.getX(i);
        uv.setY(idx, uv.getY(idx) * WALL_H / 2);
      }
    }
    const side = new THREE.MeshStandardMaterial({ map: wallTexture(), roughness: 0.92 });
    const roof = new THREE.MeshStandardMaterial({ map: roofTexture(), roughness: 1 });
    const wallMesh = new THREE.InstancedMesh(wallGeo, [side, side, roof, roof, side, side], walls.length);
    const m = new THREE.Matrix4(), col = new THREE.Color(), rand = rng(9);
    walls.forEach(([x, y], i) => {
      // різна висота кварталів — силует міста в пустелі
      const edge = x < 0 || y < 0 || x >= g.w || y >= g.h;
      const block = ((((x + 8) >> 2) * 73856093) ^ (((y + 8) >> 2) * 19349663)) >>> 0;
      const h = edge ? 1.25 : 1 + (block % 3) * 0.14;
      m.makeScale(1, h, 1).setPosition(x + 0.5, WALL_H * h / 2, y + 0.5);
      wallMesh.setMatrixAt(i, m);
      const v = 0.9 + rand() * 0.14;
      wallMesh.setColorAt(i, col.setRGB(v, v * 0.98, v * 0.95));
    });
    wallMesh.castShadow = true; wallMesh.receiveShadow = true;
    scene.add(wallMesh);
    this.wallMesh = wallMesh;

    // ящики
    const crates = [];
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.at(x, y) === 'b') crates.push([x, y]);
    const crateMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, CRATE_H, 0.9), new THREE.MeshStandardMaterial({ map: crateTexture(), roughness: 0.85 }), crates.length);
    crates.forEach(([x, y], i) => {
      m.makeRotationY((rand() - 0.5) * 0.12).setPosition(x + 0.5, CRATE_H / 2, y + 0.5);
      crateMesh.setMatrixAt(i, m);
    });
    crateMesh.castShadow = true; crateMesh.receiveShadow = true;
    scene.add(crateMesh);
    this.crateMesh = crateMesh;
  }

  // прозорий шар на підлозі: маршрути, досяжні клітинки, туман, сліди
  buildOverlay() {
    const P = 32;
    this.overlayPx = P;
    this.overlayCanvas = canvas(this.grid.w * P, this.grid.h * P);
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this.overlayTex = new THREE.CanvasTexture(this.overlayCanvas);
    this.overlayTex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(this.grid.w, this.grid.h),
      new THREE.MeshBasicMaterial({ map: this.overlayTex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(this.grid.w / 2, 0.02, this.grid.h / 2);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
  }

  drawOverlay(fn) {
    const g = this.overlayCtx, P = this.overlayPx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    g.setTransform(P, 0, 0, P, 0, 0);
    fn(g);
    this.overlayTex.needsUpdate = true;
  }

  buildBomb() {
    const grp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.24), new THREE.MeshStandardMaterial({ color: 0x3d3a2e, roughness: 0.6 }));
    body.position.y = 0.07; body.castShadow = true;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.14), new THREE.MeshStandardMaterial({ color: 0x1d2a1c }));
    panel.position.y = 0.15;
    this.bombLight = new THREE.Mesh(new THREE.SphereGeometry(0.035), new THREE.MeshBasicMaterial({ color: 0xff2a1a }));
    this.bombLight.position.set(0.11, 0.17, 0);
    grp.add(body, panel, this.bombLight);
    grp.visible = false;
    this.scene.add(grp);
    this.bomb = grp;
  }

  /* ---------------- гравці ---------------- */
  makePlayer(side) {
    const t = TEAM[side];
    const grp = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ color: t.cloth, roughness: 0.9 });
    const vestM = new THREE.MeshStandardMaterial({ color: t.vest, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd9a77c, roughness: 0.8 });
    const dark = new THREE.MeshStandardMaterial({ color: t.dark, roughness: 0.8 });
    const gunM = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.4 });
    const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.11, 0.45, 8), dark); legs.position.y = 0.23;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17, 0.3, 4, 10), cloth); body.position.y = 0.66;
    const vest = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.3, 10), vestM); vest.position.y = 0.7;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), skin); head.position.y = 1.03;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.135, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), dark); helmet.position.y = 1.05;
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.08, 0.5), gunM); gun.position.set(0.12, 0.74, -0.25);
    const bombPack = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.08), new THREE.MeshStandardMaterial({ color: 0xa02018 }));
    bombPack.position.set(0, 0.72, 0.2);
    for (const o of [legs, body, vest, head, helmet, gun]) o.castShadow = true;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.44, 32), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03;
    const body3 = new THREE.Group();
    body3.add(legs, body, vest, head, helmet, gun, bombPack);
    grp.add(body3, ring);
    this.scene.add(grp);
    return { grp, body: body3, ring, helmet, vest, bombPack, gun, yaw: 0, side, x: null, z: null, mats: [cloth, vestM, skin, dark] };
  }

  // list: [{id, side, x, y, alive, me, mate, armor, bomb, visible}]
  syncPlayers(list, dt) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      let o = this.players.get(p.id);
      if (!o || o.side !== p.side) { if (o) this.scene.remove(o.grp); o = this.makePlayer(p.side); this.players.set(p.id, o); }
      const tx = p.x + 0.5, tz = p.y + 0.5;
      if (o.x === null || Math.hypot(tx - o.x, tz - o.z) > 3) { o.x = tx; o.z = tz; }
      // плавне наближення до позиції та повороту
      const k = Math.min(1, dt * 14);
      const dx = tx - o.x, dz = tz - o.z;
      if (Math.hypot(dx, dz) > 0.02) o.wantYaw = Math.atan2(-dx, -dz);
      o.x += dx * k; o.z += dz * k;
      if (p.faceX !== undefined) o.wantYaw = Math.atan2(-(p.faceX + 0.5 - o.x), -(p.faceY + 0.5 - o.z));
      if (o.wantYaw !== undefined) {
        let d = o.wantYaw - o.yaw; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2;
        o.yaw += d * Math.min(1, dt * 10);
      }
      o.grp.position.set(o.x, 0, o.z);
      o.body.rotation.set(0, o.yaw, 0);
      o.helmet.visible = p.armor >= 2;
      o.vest.visible = p.armor >= 1;
      o.bombPack.visible = !!p.bomb && p.alive;
      o.ring.visible = p.alive && (p.me || p.mate);
      o.ring.material.color.set(p.me ? 0xffffff : (p.side === 'T' ? 0xf0a23a : 0x5aa7e8));
      o.ring.material.opacity = p.me ? 0.95 : 0.5;
      if (!p.alive) {
        // лежить на землі
        o.body.rotation.set(Math.PI / 2, o.yaw, 0, 'YXZ');
        o.body.position.y = 0.16;
        o.gun.visible = false;
        for (const m of o.mats) m.color.multiplyScalar(1); // кольори лишаємо
        o.grp.traverse((c) => { if (c.material) { c.material.transparent = true; c.material.opacity = 0.75; } });
      } else {
        o.body.position.y = 0;
        o.gun.visible = true;
        o.grp.traverse((c) => { if (c.material && c !== o.ring) { c.material.opacity = 1; c.material.transparent = false; } });
      }
      o.grp.visible = true;
    }
    for (const [id, o] of this.players) if (!seen.has(id)) o.grp.visible = false;
  }

  playerPos(id) { const o = this.players.get(id); return o && o.grp.visible ? { x: o.x, z: o.z } : null; }

  /* ---------------- дим, вогонь, бомба ---------------- */
  syncSmokes(smokes) {
    const key = JSON.stringify((smokes || []).map((s) => [s.x, s.y, s.tiles.length]));
    if (key === this.smokeKey) return;
    this.smokeKey = key;
    this.smokeGroup.clear();
    const rand = rng(77);
    for (const s of smokes || []) for (const k of s.tiles) {
      const [x, y] = k.split(',').map(Number);
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.textures.smoke, transparent: true, depthWrite: false, opacity: 0.9, color: 0xe8e6e0 }));
        const sz = 1.8 + rand() * 0.8;
        sp.scale.set(sz, sz, 1);
        sp.position.set(x + 0.5 + (rand() - 0.5) * 0.5, 0.4 + i * 0.6 + rand() * 0.3, y + 0.5 + (rand() - 0.5) * 0.5);
        sp.userData.spin = (rand() - 0.5) * 0.4;
        this.smokeGroup.add(sp);
      }
    }
  }

  syncFires(fires) {
    const key = JSON.stringify((fires || []).map((s) => [s.x, s.y, s.tiles.length]));
    if (key === this.fireKey) return;
    this.fireKey = key;
    this.fireGroup.clear();
    const rand = rng(31);
    for (const f of fires || []) for (const k of f.tiles) {
      const [x, y] = k.split(',').map(Number);
      const decal = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), new THREE.MeshBasicMaterial({ map: this.textures.scorch, transparent: true, depthWrite: false }));
      decal.rotation.x = -Math.PI / 2; decal.position.set(x + 0.5, 0.025, y + 0.5);
      this.fireGroup.add(decal);
      for (let i = 0; i < 3; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.textures.fire, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
        sp.position.set(x + 0.2 + rand() * 0.6, 0.3, y + 0.2 + rand() * 0.6);
        sp.userData.phase = rand() * 10;
        this.fireGroup.add(sp);
      }
    }
  }

  syncBomb(b) {
    if (!b || (b.state !== 'planted' && b.state !== 'dropped')) { this.bomb.visible = false; return; }
    this.bomb.visible = true;
    this.bomb.position.set(b.x + 0.5, 0, b.y + 0.5);
    this.bombPlanted = b.state === 'planted';
  }

  /* ---------------- короткі ефекти ---------------- */
  addShot(a, b, hit, start) {
    this.fx.push({ type: 'shot', a, b, hit, start, dur: 180 });
  }
  addThrow(from, to, nade, start) { this.fx.push({ type: 'throw', from, to, nade, start, dur: 380 }); }
  addBlast(nade, x, y, start) { this.fx.push({ type: 'blast', nade, x, y, start, dur: nade === 'flash' ? 500 : 800 }); }

  updateFx(now) {
    this.fxGroup.clear();
    this.fx = this.fx.filter((f) => now < f.start + f.dur);
    for (const f of this.fx) {
      const k = (now - f.start) / f.dur;
      if (k < 0) continue;
      if (f.type === 'shot') {
        const from = new THREE.Vector3(f.a.x + 0.5, 0.8, f.a.y + 0.5);
        const to = new THREE.Vector3(f.b.x + 0.5 + (f.hit ? 0 : 0.4), f.hit ? 0.8 : 1.3, f.b.y + 0.5 + (f.hit ? 0 : -0.3));
        const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
        this.fxGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: f.hit ? 0xffe27a : 0xffffff, transparent: true, opacity: 1 - k })));
        const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.textures.flash, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 - k }));
        flash.position.copy(from); flash.scale.set(0.6, 0.6, 1);
        this.fxGroup.add(flash);
      } else if (f.type === 'throw') {
        const x = f.from.x + (f.to.x - f.from.x) * k + 0.5, z = f.from.y + (f.to.y - f.from.y) * k + 0.5;
        const y = 0.9 + Math.sin(k * Math.PI) * 2;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshStandardMaterial({ color: 0x3a4a2a }));
        ball.position.set(x, y, z);
        this.fxGroup.add(ball);
      } else if (f.type === 'blast') {
        const tex = f.nade === 'flash' ? this.textures.flash : f.nade === 'smoke' ? this.textures.smoke : this.textures.blast;
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: f.nade === 'smoke' ? THREE.NormalBlending : THREE.AdditiveBlending, opacity: 1 - k }));
        const sz = (f.nade === 'flash' ? 9 : f.nade === 'he' ? 5 : 3) * (0.4 + k * 0.6);
        sp.scale.set(sz, sz, 1); sp.position.set(f.x + 0.5, 0.8, f.y + 0.5);
        this.fxGroup.add(sp);
      }
    }
  }

  /* ---------------- камера ---------------- */
  resize(w, h) {
    this.W = w; this.H = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clampView() {
    const v = this.view;
    v.dist = Math.max(6, Math.min(48, v.dist));
    v.tx = Math.max(0, Math.min(this.grid.w, v.tx));
    v.tz = Math.max(0, Math.min(this.grid.h, v.tz));
  }

  pan(dxPx, dyPx) {
    const v = this.view;
    const scale = (2 * v.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / this.H;
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const fk = 1 / Math.sin(v.pitch); // на нахиленій камері вертикаль тягне далі
    v.tx -= (dxPx * rx - dyPx * fx * fk) * scale;
    v.tz -= (dxPx * rz - dyPx * fz * fk) * scale;
    this.anim = null;
    this.clampView();
  }

  zoom(f) { this.view.dist /= f; this.anim = null; this.clampView(); }

  animateTo(target, ms = 600) {
    this.anim = { from: { ...this.view }, to: { ...this.view, ...target }, start: performance.now(), ms };
  }

  rotate(dir) {
    const to = this.view.yaw + dir * Math.PI / 2;
    this.animateTo({ yaw: to }, 450);
  }

  toggleTop() {
    this.animateTo({ pitch: this.view.pitch > 1.3 ? 1.1 : 1.48 }, 450);
    return this.view.pitch <= 1.3;
  }

  follow(x, y) {
    const p = this.project(x + 0.5, 0, y + 0.5);
    if (p.x > this.W * 0.2 && p.x < this.W * 0.8 && p.y > this.H * 0.2 && p.y < this.H * 0.8) return;
    this.animateTo({ tx: x + 0.5, tz: y + 0.5 });
  }

  centerOn(x, y, dist) { this.animateTo({ tx: x + 0.5, tz: y + 0.5, ...(dist ? { dist } : {}) }); }

  updateCamera(now) {
    if (this.anim) {
      const a = this.anim, k = Math.min(1, (now - a.start) / a.ms), e = 1 - Math.pow(1 - k, 3);
      for (const key of ['tx', 'tz', 'dist', 'pitch', 'yaw']) this.view[key] = a.from[key] + (a.to[key] - a.from[key]) * e;
      if (k >= 1) this.anim = null;
    }
    const v = this.view, c = this.camera;
    c.position.set(v.tx + v.dist * Math.cos(v.pitch) * Math.sin(v.yaw), v.dist * Math.sin(v.pitch), v.tz + v.dist * Math.cos(v.pitch) * Math.cos(v.yaw));
    c.lookAt(v.tx, 0, v.tz);
    c.updateMatrixWorld();
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    return { x: (v.x + 1) / 2 * this.W, y: (1 - v.y) / 2 * this.H, behind: v.z > 1 };
  }

  // екранні координати → клітинка
  pick(px, py) {
    const ndc = new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects([this.wallMesh, this.crateMesh], false);
    if (hits.length) {
      const h = hits[0];
      const n = h.face ? h.face.normal.clone() : new THREE.Vector3(0, 1, 0);
      if (n.y > 0.5) return { x: Math.floor(h.point.x), y: Math.floor(h.point.z) }; // дах стіни або кришка ящика
      const p = h.point.clone().addScaledVector(n, 0.4);
      return { x: Math.floor(p.x), y: Math.floor(p.z) };
    }
    const ray = this.raycaster.ray;
    if (Math.abs(ray.direction.y) < 1e-4) return null;
    const t = -ray.origin.y / ray.direction.y;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    return { x: Math.floor(p.x), y: Math.floor(p.z) };
  }

  // точка на землі під екранною точкою (для рамки на радарі)
  pickGround(px, py) {
    const ndc = new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    if (ray.direction.y > -1e-4) return null;
    const t = -ray.origin.y / ray.direction.y;
    const p = ray.origin.clone().addScaledVector(ray.direction, t);
    return { x: p.x, z: p.z };
  }

  render(now) {
    this.updateCamera(now);
    this.updateFx(now);
    for (const sp of this.smokeGroup.children) sp.material.rotation += sp.userData.spin * 0.016;
    for (const sp of this.fireGroup.children) if (sp.isSprite) {
      const s = 0.7 + 0.25 * Math.sin(now / 90 + sp.userData.phase);
      sp.scale.set(s, s * 1.3, 1);
    }
    if (this.bomb.visible) this.bombLight.visible = !this.bombPlanted || Math.floor(now / 400) % 2 === 0;
    this.renderer.render(this.scene, this.camera);
  }
}
