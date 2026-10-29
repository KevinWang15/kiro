// Pac-Man easter egg: click the rail logo three times in a row and its ghost
// flies out into a full-screen Pac-Man maze. Self-contained: delete this
// directory and the two "easter-egg" lines in index.html to remove it.

const CLICKS_NEEDED = 3;
const CLICK_WINDOW_MS = 500; // max gap between consecutive logo clicks
const HIGH_SCORE_KEY = "kiro-pacman-high";

// 28x31 classic layout. # wall, . dot, o power pellet, - ghost-house door.
const MAZE = [
  "############################",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#o####.#####.##.#####.####o#",
  "#.####.#####.##.#####.####.#",
  "#..........................#",
  "#.####.##.########.##.####.#",
  "#.####.##.########.##.####.#",
  "#......##....##....##......#",
  "######.##### ## #####.######",
  "     #.##### ## #####.#     ",
  "     #.##          ##.#     ",
  "     #.## ###--### ##.#     ",
  "######.## #      # ##.######",
  "      .   #      #   .      ",
  "######.## #      # ##.######",
  "     #.## ######## ##.#     ",
  "     #.##          ##.#     ",
  "     #.## ######## ##.#     ",
  "######.## ######## ##.######",
  "#............##............#",
  "#.####.#####.##.#####.####.#",
  "#.####.#####.##.#####.####.#",
  "#o..##.......  .......##..o#",
  "###.##.##.########.##.##.###",
  "###.##.##.########.##.##.###",
  "#......##....##....##......#",
  "#.##########.##.##########.#",
  "#.##########.##.##########.#",
  "#..........................#",
  "############################",
];
const COLS = 28;
const ROWS = MAZE.length;
const FOOTER_ROWS = 2; // lives are drawn under the maze
const HOUSE_EXIT = { x: 13, y: 11 };
const HOUSE_INSIDE_Y = 14;
const PAC_START = { x: 13, y: 23 };
const READY_ROW = 17;

// Same shape as the logo in index.html (24x24 viewBox, centred on 12,12).
const GHOST_D =
  "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z";
const SVG_NS = "http://www.w3.org/2000/svg";

const NONE = { x: 0, y: 0 };
const UP = { x: 0, y: -1 };
const DOWN = { x: 0, y: 1 };
const LEFT = { x: -1, y: 0 };
const RIGHT = { x: 1, y: 0 };
// Classic tie-break order when two directions are equally good.
const GHOST_DIRS = [UP, LEFT, DOWN, RIGHT];
const KEY_DIRS = {
  ArrowUp: UP, KeyW: UP,
  ArrowDown: DOWN, KeyS: DOWN,
  ArrowLeft: LEFT, KeyA: LEFT,
  ArrowRight: RIGHT, KeyD: RIGHT,
};
// Scatter/chase phases in seconds, alternating and starting with scatter.
const MODE_SCHEDULE = [7, 20, 7, 20, 5, 20, 5, Infinity];

const COLORS = {
  wall: "#8b5cf6",
  wallFill: "#8b5cf61a",
  wallFlash: "#e8e8ec",
  door: "#f0abfc",
  dot: "#e9d5ff",
  pac: "#facc15",
  frightened: "#4f46e5",
  frightenedFlash: "#f8fafc",
  eye: "#111114",
  text: "#e8e8ec",
  ready: "#facc15",
  gameOver: "#f87171",
};

const sameDir = (a, b) => a.x === b.x && a.y === b.y;
const isOpposite = (a, b) => a.x === -b.x && a.y === -b.y && (a.x || a.y);
const isTunnelRow = (row) => MAZE[row]?.[0] === " ";

function readHighScore() {
  try {
    return Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0;
  } catch {
    return 0;
  }
}
function writeHighScore(value) {
  try {
    localStorage.setItem(HIGH_SCORE_KEY, String(value));
  } catch {
    // Storage may be blocked; the high score just won't persist.
  }
}

function tileAt(col, row) {
  if (row < 0 || row >= ROWS) return "#";
  if (col < 0 || col >= COLS) return isTunnelRow(row) ? " " : "#";
  return MAZE[row][col];
}
// Pac-Man and roaming ghosts can't pass walls or the ghost-house door.
const isOpen = (col, row) => !"#-".includes(tileAt(col, row));

// Moves an entity `dist` tiles along the grid. Whenever it lands exactly on a
// tile centre, `decide` may change its direction (or stop it with NONE).
function advance(ent, dist, decide) {
  for (let guard = 0; dist > 1e-9 && guard < 8; guard++) {
    const cx = Math.round(ent.x);
    const cy = Math.round(ent.y);
    if (Math.abs(ent.x - cx) < 1e-6 && Math.abs(ent.y - cy) < 1e-6) {
      ent.x = cx;
      ent.y = cy;
      // Tunnel: leaving one side re-enters from the other.
      if (ent.x <= -1) ent.x = COLS;
      else if (ent.x >= COLS) ent.x = -1;
      decide(ent);
    }
    if (sameDir(ent.dir, NONE)) return;
    const tx = ent.dir.x > 0 ? Math.floor(ent.x) + 1 : ent.dir.x < 0 ? Math.ceil(ent.x) - 1 : ent.x;
    const ty = ent.dir.y > 0 ? Math.floor(ent.y) + 1 : ent.dir.y < 0 ? Math.ceil(ent.y) - 1 : ent.y;
    const toCentre = Math.abs(tx - ent.x) + Math.abs(ty - ent.y);
    const step = Math.min(dist, toCentre);
    ent.x += ent.dir.x * step;
    ent.y += ent.dir.y * step;
    dist -= step;
    if (step === toCentre) {
      ent.x = tx;
      ent.y = ty;
    }
  }
}

// Straight-line movement used inside the ghost house, where the grid rules
// don't apply. Moves horizontally first, then vertically. True on arrival.
function glide(ent, tx, ty, dist) {
  const dx = tx - ent.x;
  const mx = Math.sign(dx) * Math.min(Math.abs(dx), dist);
  ent.x += mx;
  dist -= Math.abs(mx);
  const dy = ty - ent.y;
  const my = Math.sign(dy) * Math.min(Math.abs(dy), dist);
  ent.y += my;
  ent.dir = mx ? { x: Math.sign(mx), y: 0 } : my ? { x: 0, y: Math.sign(my) } : ent.dir;
  return ent.x === tx && ent.y === ty;
}

function createGame(canvas, hud) {
  const ctx = canvas.getContext("2d");
  const ghostBody = new Path2D(GHOST_D);
  let tile = 16;
  let wallFill = new Path2D();
  let wallEdges = new Path2D();
  let doorPath = new Path2D();

  const s = {
    state: "ready", // ready | playing | dying | cleared | gameover
    timer: 0,
    paused: false,
    score: 0,
    high: readHighScore(),
    level: 1,
    lives: 3,
    dots: new Set(),
    power: new Set(),
    modeIndex: 0,
    modeTimer: 0,
    frightTimer: 0,
    ghostCombo: 0,
    freeze: 0,
    popups: [],
    pac: null,
    ghosts: [],
    wanted: LEFT,
    hideKiro: true, // the logo ghost is still flying in
    time: 0,
  };

  function resetDots() {
    s.dots.clear();
    s.power.clear();
    MAZE.forEach((line, row) =>
      [...line].forEach((ch, col) => {
        if (ch === ".") s.dots.add(row * COLS + col);
        if (ch === "o") s.power.add(row * COLS + col);
      }),
    );
  }

  function resetActors() {
    s.pac = { ...PAC_START, dir: LEFT, facing: LEFT, chomp: 0 };
    s.wanted = LEFT;
    const ghost = (name, color, x, y, mode, release, corner) => ({
      name, color, x, y, mode, release, corner,
      homeX: x,
      dir: mode === "active" ? LEFT : UP,
      frightened: false,
      decidedAt: -1,
    });
    s.ghosts = [
      // The logo ghost takes Blinky's role and starts outside the house.
      ghost("kiro", "#ffffff", HOUSE_EXIT.x, HOUSE_EXIT.y, "active", 0, { x: COLS - 3, y: -3 }),
      ghost("pinky", "#f472b6", 13, HOUSE_INSIDE_Y, "house", 1, { x: 2, y: -3 }),
      ghost("inky", "#22d3ee", 11, HOUSE_INSIDE_Y, "house", 4, { x: COLS - 1, y: ROWS }),
      ghost("clyde", "#fb923c", 16, HOUSE_INSIDE_Y, "house", 7, { x: 0, y: ROWS }),
    ];
    s.modeIndex = 0;
    s.modeTimer = 0;
    s.frightTimer = 0;
    s.freeze = 0;
    s.popups = [];
    s.state = "ready";
    s.timer = 0;
  }

  function newGame() {
    s.score = 0;
    s.level = 1;
    s.lives = 3;
    resetDots();
    resetActors();
    updateHud();
  }

  function updateHud() {
    if (s.score > s.high) {
      s.high = s.score;
      writeHighScore(s.high);
    }
    hud.score.textContent = s.score;
    hud.high.textContent = s.high;
    hud.level.textContent = s.level;
  }

  const levelSpeed = () => Math.min(1 + (s.level - 1) * 0.05, 1.25);
  const chasing = () => s.modeIndex % 2 === 1;

  function ghostTarget(g) {
    const pac = s.pac;
    if (g.mode === "eaten") return HOUSE_EXIT;
    if (!chasing()) return g.corner;
    const pc = { x: Math.round(pac.x), y: Math.round(pac.y) };
    const f = pac.facing;
    switch (g.name) {
      case "pinky":
        return { x: pc.x + f.x * 4, y: pc.y + f.y * 4 };
      case "inky": {
        const kiro = s.ghosts[0];
        const ax = pc.x + f.x * 2;
        const ay = pc.y + f.y * 2;
        return { x: 2 * ax - Math.round(kiro.x), y: 2 * ay - Math.round(kiro.y) };
      }
      case "clyde":
        return Math.hypot(pc.x - g.x, pc.y - g.y) > 8 ? pc : g.corner;
      default:
        return pc;
    }
  }

  function decideGhost(g) {
    const key = Math.round(g.y) * (COLS + 2) + Math.round(g.x);
    // Decide once per tile, so a frame ending exactly on a centre can't
    // trigger a second choice there.
    if (key === g.decidedAt && isOpen(g.x + g.dir.x, g.y + g.dir.y)) return;
    g.decidedAt = key;
    if (g.mode === "eaten" && g.x === HOUSE_EXIT.x && g.y === HOUSE_EXIT.y) {
      g.mode = "entering";
      g.dir = NONE;
      return;
    }
    let options = GHOST_DIRS.filter(
      (d) => !isOpposite(d, g.dir) && isOpen(g.x + d.x, g.y + d.y),
    );
    if (!options.length) options = GHOST_DIRS.filter((d) => isOpen(g.x + d.x, g.y + d.y));
    if (!options.length) return void (g.dir = NONE);
    if (g.frightened) {
      g.dir = options[Math.floor(Math.random() * options.length)];
      return;
    }
    const target = ghostTarget(g);
    let best = options[0];
    let bestDist = Infinity;
    for (const d of options) {
      const dist = (g.x + d.x - target.x) ** 2 + (g.y + d.y - target.y) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    g.dir = best;
  }

  function decidePac(p) {
    if (isOpen(p.x + s.wanted.x, p.y + s.wanted.y)) p.dir = s.wanted;
    else if (!isOpen(p.x + p.dir.x, p.y + p.dir.y)) p.dir = NONE;
    if (!sameDir(p.dir, NONE)) p.facing = p.dir;
  }

  function reverseRoamingGhosts() {
    for (const g of s.ghosts) {
      if (g.mode !== "active") continue;
      g.dir = { x: -g.dir.x, y: -g.dir.y };
      g.decidedAt = -1;
    }
  }

  function eatAt(col, row) {
    const key = row * COLS + col;
    if (s.dots.delete(key)) {
      s.score += 10;
    } else if (s.power.delete(key)) {
      s.score += 50;
      s.frightTimer = Math.max(2, 7 - (s.level - 1));
      s.ghostCombo = 0;
      reverseRoamingGhosts();
      for (const g of s.ghosts) if (g.mode === "active") g.frightened = true;
    } else {
      return;
    }
    updateHud();
    if (!s.dots.size && !s.power.size) {
      s.state = "cleared";
      s.timer = 0;
    }
  }

  function updateGhost(g, dt) {
    const speed = levelSpeed();
    switch (g.mode) {
      case "house":
        g.y = HOUSE_INSIDE_Y + Math.sin(s.time * 6 + g.homeX) * 0.3;
        if (s.timer >= g.release) g.mode = "leaving";
        return;
      case "leaving":
        if (glide(g, HOUSE_EXIT.x, HOUSE_EXIT.y, 3 * dt)) {
          g.mode = "active";
          g.dir = LEFT;
          g.decidedAt = -1;
        }
        return;
      case "entering":
        if (glide(g, HOUSE_EXIT.x, HOUSE_INSIDE_Y, 8 * dt)) {
          g.mode = "leaving";
          g.frightened = false;
        }
        return;
      case "eaten":
        advance(g, 15 * dt, decideGhost);
        return;
      default: {
        const inTunnel = Math.round(g.y) === 14 && (g.x < 6 || g.x > 21);
        const v = inTunnel ? 3.8 : g.frightened ? 4.2 : 7.2 * speed;
        advance(g, v * dt, decideGhost);
      }
    }
  }

  function update(dt) {
    s.time += dt;
    s.timer += dt;
    for (const p of s.popups) p.t += dt;
    s.popups = s.popups.filter((p) => p.t < 1);

    if (s.state === "ready") {
      if (s.timer > 2 && !s.hideKiro) {
        s.state = "playing";
        s.timer = 0;
      }
      return;
    }
    if (s.state === "dying") {
      if (s.timer > 1.6) {
        s.lives -= 1;
        if (s.lives <= 0) {
          s.state = "gameover";
          s.timer = 0;
        } else {
          resetActors();
        }
      }
      return;
    }
    if (s.state === "cleared") {
      if (s.timer > 2) {
        s.level += 1;
        resetDots();
        resetActors();
        updateHud();
      }
      return;
    }
    if (s.state !== "playing") return;
    if (s.freeze > 0) {
      s.freeze -= dt;
      return;
    }

    // Scatter/chase clock pauses while the ghosts are frightened.
    if (s.frightTimer > 0) {
      s.frightTimer -= dt;
      if (s.frightTimer <= 0) for (const g of s.ghosts) g.frightened = false;
    } else {
      s.modeTimer += dt;
      if (s.modeTimer >= MODE_SCHEDULE[s.modeIndex]) {
        s.modeTimer = 0;
        s.modeIndex += 1;
        reverseRoamingGhosts();
      }
    }

    const pac = s.pac;
    // Pac-Man may reverse at any point, not only on a tile centre.
    if (isOpposite(s.wanted, pac.dir)) {
      pac.dir = s.wanted;
      pac.facing = s.wanted;
    }
    const before = pac.x + pac.y;
    advance(pac, 7.6 * levelSpeed() * dt, decidePac);
    pac.chomp += Math.abs(pac.x + pac.y - before);
    eatAt(Math.round(pac.x), Math.round(pac.y));
    if (s.state !== "playing") return;

    for (const g of s.ghosts) {
      updateGhost(g, dt);
      if (g.mode !== "active") continue;
      if (Math.hypot(g.x - pac.x, g.y - pac.y) > 0.65) continue;
      if (g.frightened) {
        const points = 200 * 2 ** s.ghostCombo++;
        s.score += points;
        s.popups.push({ x: g.x, y: g.y, text: String(points), t: 0 });
        g.mode = "eaten";
        g.frightened = false;
        g.decidedAt = -1;
        s.freeze = 0.5;
        updateHud();
      } else {
        s.state = "dying";
        s.timer = 0;
        return;
      }
    }
  }

  // ---- Rendering ----------------------------------------------------------

  function buildMaze() {
    wallFill = new Path2D();
    wallEdges = new Path2D();
    doorPath = new Path2D();
    const isWall = (c, r) => MAZE[r]?.[c] === "#";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = c * tile;
        const y = r * tile;
        if (MAZE[r][c] === "-") {
          doorPath.moveTo(x, y + tile / 2);
          doorPath.lineTo(x + tile, y + tile / 2);
        }
        if (!isWall(c, r)) continue;
        wallFill.rect(x, y, tile, tile);
        // Outline only the edges that face a corridor, giving hollow blocks.
        const edge = (x1, y1, x2, y2) => {
          wallEdges.moveTo(x1, y1);
          wallEdges.lineTo(x2, y2);
        };
        if (!isWall(c, r - 1)) edge(x, y, x + tile, y);
        if (!isWall(c, r + 1)) edge(x, y + tile, x + tile, y + tile);
        if (!isWall(c - 1, r)) edge(x, y, x, y + tile);
        if (!isWall(c + 1, r)) edge(x + tile, y, x + tile, y + tile);
      }
    }
  }

  function resize() {
    const fit = Math.min(
      (window.innerWidth - 64) / COLS,
      (window.innerHeight - 150) / (ROWS + FOOTER_ROWS),
    );
    tile = Math.max(8, Math.min(24, Math.floor(fit)));
    const dpr = window.devicePixelRatio || 1;
    const w = COLS * tile;
    const h = (ROWS + FOOTER_ROWS) * tile;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildMaze();
    draw();
  }

  const centre = (v) => (v + 0.5) * tile;

  function drawPac(p, mouth) {
    const angle = Math.atan2(p.facing.y, p.facing.x);
    const x = centre(p.x);
    const y = centre(p.y);
    ctx.fillStyle = COLORS.pac;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, tile * 0.75, angle + mouth, angle + Math.PI * 2 - mouth);
    ctx.closePath();
    ctx.fill();
  }

  function drawGhost(g) {
    const scale = (tile * 1.3) / 16;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.translate(centre(g.x), centre(g.y));
    ctx.scale(scale, scale);
    ctx.translate(-12, -12);
    const lookX = g.dir.x * 1.1;
    const lookY = g.dir.y * 0.9;
    if (g.mode === "eaten") {
      for (const ex of [9.2, 14.8]) {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.ellipse(ex, 10.5, 1.9, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = COLORS.frightened;
        ctx.beginPath();
        ctx.ellipse(ex + lookX, 10.5 + lookY, 1, 1.3, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    const flashing = g.frightened && s.frightTimer < 2 && Math.floor(s.time * 5) % 2 === 0;
    ctx.fillStyle = g.frightened
      ? flashing ? COLORS.frightenedFlash : COLORS.frightened
      : g.color;
    if (g.name === "kiro" && !g.frightened) {
      ctx.shadowColor = "#a78bfa";
      ctx.shadowBlur = tile * 0.8 * dpr;
    }
    ctx.fill(ghostBody);
    ctx.shadowBlur = 0;
    if (g.frightened) {
      ctx.fillStyle = flashing ? "#ef4444" : "#fde68a";
      ctx.fillRect(8.4, 9, 1.8, 2.2);
      ctx.fillRect(13.8, 9, 1.8, 2.2);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(7, 15.5);
      for (let i = 1; i <= 6; i++) ctx.lineTo(7 + i * (10 / 6), i % 2 ? 14 : 15.5);
      ctx.stroke();
    } else {
      // Logo-style eyes that look where the ghost is heading.
      ctx.fillStyle = COLORS.eye;
      for (const ex of [9.2, 14.8]) {
        ctx.beginPath();
        ctx.ellipse(ex + lookX, 10.5 + lookY, 1.1, 1.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawText(text, color, row = READY_ROW, size = 0.95) {
    ctx.fillStyle = color;
    ctx.font = `700 ${Math.round(tile * size)}px "JetBrains Mono Variable", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, (COLS * tile) / 2, centre(row));
  }

  function draw() {
    if (!s.pac) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const flash = s.state === "cleared" && Math.floor(s.timer * 4) % 2 === 1;
    ctx.fillStyle = COLORS.wallFill;
    ctx.fill(wallFill);
    ctx.strokeStyle = flash ? COLORS.wallFlash : COLORS.wall;
    ctx.lineWidth = Math.max(1.5, tile / 8);
    ctx.lineCap = "round";
    ctx.stroke(wallEdges);
    ctx.strokeStyle = COLORS.door;
    ctx.lineWidth = Math.max(1, tile / 6);
    ctx.stroke(doorPath);

    ctx.fillStyle = COLORS.dot;
    for (const key of s.dots) {
      ctx.beginPath();
      ctx.arc(centre(key % COLS), centre(Math.floor(key / COLS)), tile * 0.13, 0, Math.PI * 2);
      ctx.fill();
    }
    if (s.state !== "playing" || Math.floor(s.time * 4) % 2 === 0) {
      for (const key of s.power) {
        ctx.beginPath();
        ctx.arc(centre(key % COLS), centre(Math.floor(key / COLS)), tile * 0.36, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Clip actors to the maze so tunnel travel doesn't spill into the footer.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, COLS * tile, ROWS * tile);
    ctx.clip();
    const showGhosts =
      s.state !== "cleared" && s.state !== "gameover" && !(s.state === "dying" && s.timer > 0.5);
    if (showGhosts) {
      for (const g of s.ghosts) {
        if (g.name === "kiro" && s.hideKiro) continue;
        // The ghost just eaten turns into its score while the game freezes.
        if (s.freeze > 0 && g.mode === "eaten" && s.popups.some((p) => p.x === g.x && p.y === g.y)) continue;
        drawGhost(g);
      }
    }
    if (s.state === "dying") {
      const t = Math.min(1, Math.max(0, s.timer - 0.5) / 0.9);
      if (t < 1) drawPac({ ...s.pac, facing: UP }, 0.1 + t * (Math.PI - 0.1));
    } else if (s.state !== "gameover" && !(s.freeze > 0)) {
      const moving = s.state === "playing" && !sameDir(s.pac.dir, NONE);
      const mouth = moving ? 0.06 + 0.7 * Math.abs(Math.sin(s.pac.chomp * Math.PI)) : 0.35;
      drawPac(s.pac, mouth);
    }
    ctx.restore();

    ctx.fillStyle = "#93c5fd";
    ctx.font = `700 ${Math.round(tile * 0.7)}px "JetBrains Mono Variable", ui-monospace, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of s.popups) ctx.fillText(p.text, centre(p.x), centre(p.y) - p.t * tile * 0.6);

    // Remaining lives, not counting the one in play.
    for (let i = 0; i < s.lives - 1; i++) {
      drawPac({ x: 1.5 + i * 2, y: ROWS + 0.5, facing: LEFT }, 0.5);
    }

    if (s.state === "ready") drawText("READY!", COLORS.ready);
    if (s.state === "gameover") {
      drawText("GAME OVER", COLORS.gameOver);
      // Row 11 is the open corridor above the ghost house.
      drawText("ENTER TO PLAY AGAIN", COLORS.text, 11, 0.6);
    }
    if (s.paused && s.state === "playing") drawText("PAUSED", COLORS.text);
  }

  let frame = 0;
  let last = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    if (!s.paused) update(dt);
    draw();
    frame = requestAnimationFrame(loop);
  }

  newGame();

  return {
    start() {
      last = performance.now();
      frame = requestAnimationFrame(loop);
    },
    stop() {
      cancelAnimationFrame(frame);
    },
    resize,
    steer(dir) {
      s.wanted = dir;
      if (s.paused) s.paused = false;
    },
    confirm() {
      if (s.state === "gameover") newGame();
      else if (s.state === "playing") s.paused = !s.paused;
    },
    pause() {
      if (s.state === "playing") s.paused = true;
    },
    togglePause() {
      if (s.state === "playing") s.paused = !s.paused;
    },
    tile: () => tile,
    showKiro() {
      s.hideKiro = false;
      s.timer = 0;
    },
    // Where the logo ghost is, in canvas pixels, so it can fly back home.
    kiroCentre() {
      const g = s.ghosts[0];
      return { x: centre(g.x), y: centre(g.y) };
    },
  };
}

// ---- Logo ghost flight ------------------------------------------------------

function makeFlyingGhost() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("egg-flying-ghost");
  svg.innerHTML =
    `<path class="ghost-body" d="${GHOST_D}"/>` +
    '<ellipse class="ghost-eye" cx="9.2" cy="10.5" rx="1.1" ry="1.8"/>' +
    '<ellipse class="ghost-eye" cx="14.8" cy="10.5" rx="1.1" ry="1.8"/>';
  return svg;
}

// Flies a ghost between two boxes ({x, y, size} in viewport px, where size
// covers the 24-unit viewBox), with a swooping arc and a little spin.
function fly(from, to) {
  const ghost = makeFlyingGhost();
  document.body.append(ghost);
  const frame = (x, y, size, rotate = 0) => ({
    transform: `translate(${x}px, ${y}px) scale(${size / 24}) rotate(${rotate}deg)`,
  });
  const big = Math.max(from.size, to.size) * 2;
  const animation = ghost.animate(
    [
      frame(from.x, from.y, from.size),
      { ...frame(from.x + (to.x - from.x) * 0.25, from.y + (to.y - from.y) * 0.05, from.size * 1.4, -14), offset: 0.2 },
      { ...frame(from.x + (to.x - from.x) * 0.7, from.y + (to.y - from.y) * 0.45, big, 12), offset: 0.6 },
      frame(to.x, to.y, to.size),
    ],
    { duration: 950, easing: "cubic-bezier(.45,0,.25,1)", fill: "forwards" },
  );
  return animation.finished.catch(() => {}).then(() => ghost.remove());
}

// ---- Overlay ---------------------------------------------------------------

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

function openEasterEgg(logo, onClosed) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const overlay = document.createElement("div");
  overlay.className = "egg-pacman";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Pac-Man");
  overlay.tabIndex = -1;
  overlay.innerHTML = `
    <div class="egg-frame">
      <div class="egg-hud">
        <span>SCORE<b data-score>0</b></span>
        <span>HIGH<b data-high>0</b></span>
        <span>LEVEL<b data-level>1</b></span>
        <span class="egg-spacer"></span>
        <button class="egg-close" type="button" aria-label="Close Pac-Man">${CLOSE_ICON}</button>
      </div>
      <canvas role="img" aria-label="Pac-Man maze"></canvas>
      <p class="egg-hint">Arrows / WASD or swipe to move · P to pause · Esc to exit</p>
    </div>`;
  const canvas = overlay.querySelector("canvas");
  const closeButton = overlay.querySelector(".egg-close");
  const game = createGame(canvas, {
    score: overlay.querySelector("[data-score]"),
    high: overlay.querySelector("[data-high]"),
    level: overlay.querySelector("[data-level]"),
  });

  const logoSvg = logo.querySelector("svg");
  const logoBox = () => {
    const box = logoSvg.getBoundingClientRect();
    return { x: box.left, y: box.top, size: box.width };
  };
  // The box the flying ghost should match to line up with the canvas ghost.
  const mazeGhostBox = () => {
    const box = canvas.getBoundingClientRect();
    const tile = game.tile();
    const size = ((tile * 1.3) / 16) * 24;
    const c = game.kiroCentre();
    return { x: box.left + c.x - size / 2, y: box.top + c.y - size / 2, size };
  };

  let closing = false;
  const onKey = (event) => {
    const dir = KEY_DIRS[event.code];
    if (dir) game.steer(dir);
    else if (event.key === "Escape") close();
    else if (event.key === "Enter" || event.key === " ") {
      // Let a focused close button activate normally.
      if (document.activeElement === closeButton) return;
      game.confirm();
    } else if (event.code === "KeyP") game.togglePause();
    else if (event.key === "Tab") closeButton.focus();
    else return;
    // Keep arrows from scrolling and the app's own shortcuts from firing.
    event.preventDefault();
    event.stopPropagation();
  };
  let swipeStart = null;
  const onPointerDown = (event) => {
    if (event.target === canvas) swipeStart = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event) => {
    if (!swipeStart) return;
    const dx = event.clientX - swipeStart.x;
    const dy = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.hypot(dx, dy) < 20) return game.confirm();
    game.steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? RIGHT : LEFT) : dy > 0 ? DOWN : UP);
  };
  const onBackdrop = (event) => {
    if (event.target === overlay) close();
  };
  const onResize = () => game.resize();
  const onHidden = () => game.pause();

  function close() {
    if (closing) return;
    closing = true;
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("blur", onHidden);
    const from = mazeGhostBox();
    game.stop();
    overlay.classList.remove("open");
    const finish = () => {
      overlay.remove();
      logo.classList.remove("egg-ghost-away");
      logo.focus({ preventScroll: true });
      onClosed();
    };
    if (reduceMotion) return finish();
    canvas.style.visibility = "hidden";
    fly(from, logoBox()).then(finish);
  }

  closeButton.addEventListener("click", close);
  overlay.addEventListener("click", onBackdrop);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("blur", onHidden);

  document.body.append(overlay);
  game.resize();
  game.start();
  overlay.focus({ preventScroll: true });
  requestAnimationFrame(() => overlay.classList.add("open"));

  if (reduceMotion) return game.showKiro();
  const from = logoBox();
  logo.classList.add("egg-ghost-away");
  fly(from, mazeGhostBox()).then(() => {
    if (!closing) game.showKiro();
  });
}

// ---- Trigger -----------------------------------------------------------------

(() => {
  const logo = document.querySelector(".rail-logo");
  if (!logo) return;
  let clicks = 0;
  let lastClick = 0;
  let open = false;
  logo.addEventListener("click", (event) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      clicks = 0;
      return;
    }
    if (open) return event.preventDefault();
    const now = performance.now();
    clicks = now - lastClick < CLICK_WINDOW_MS ? clicks + 1 : 1;
    lastClick = now;
    if (clicks < CLICKS_NEEDED) return;
    clicks = 0;
    // This listener runs before app.js's document-level router, which skips
    // clicks that were already handled.
    event.preventDefault();
    open = true;
    openEasterEgg(logo, () => (open = false));
  });
})();
