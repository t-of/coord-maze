import { makeCoordPuzzle } from './puzzle.js?v=fe00680b';
import { randomSeedString } from './rng.js?v=fe00680b';
import { CoordBoard, axisColor, axisName } from './coordboard.js?v=fe00680b';
import { confirmDialog, isDialogOpen } from './ui.js?v=fe00680b';
import { installStarfield } from './starfield.js?v=fe00680b';
import { installShare } from './share.js?v=fe00680b';
import { installOffline } from './offline.js?v=fe00680b';
import { sound, armSound } from './sound.js?v=fe00680b';

const $ = (id) => document.getElementById(id);
const RANK = 2;     // チュートリアルは 2 次元固定 (迷路の絵が描ける最大が 3 次元、
const WIDTH = 4;    //  並べて見比べるなら 2 次元がいちばん分かりやすい)
const CS = 62;      // 迷路 1 マスの大きさ (px)
const PAD = 30;

// 操作の言い方は端末に合わせる。指で遊ぶ人に「← を押す」と書いても伝わらない。
const TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const SAY = TOUCH ? {
  move: '<b>コマの隣のマスをタップ</b>するか、その<b>行を左右にスワイプ</b>します',
  otherRow: '<b>もう一方の行</b>を触って',
  tryPush: '<b>スワイプしてみてください</b>',
  goBack: '<b>左どなりのマスをタップして座標を 1 減らす手</b>を使ってみましょう',
} : {
  move: '<b>↑↓ で行を選び、←→ でその行のコマを動かします</b>',
  otherRow: '<b>↑↓ で行を切り替えて</b>',
  tryPush: '<b>← か →</b> を押してみてください',
  goBack: '<b>← を押して座標を 1 減らす手</b>を使ってみましょう',
};

const COL_X = axisColor(0, RANK);
const COL_Y = axisColor(1, RANK);
const BAND_X = axisColor(0, RANK, 0.07);   // 左の表の行と同じ色でないと対応が読めない
const BAND_Y = axisColor(1, RANK, 0.07);
const BAND_X_ON = axisColor(0, RANK, 0.18); // 選択中の行は濃く
const BAND_Y_ON = axisColor(1, RANK, 0.18);

const STEPS = [
  {
    title: '見比べる',
    hint: '右の迷路の <b>●</b> があなたです。左の <b>x の行</b>のコマが迷路での<b>横位置</b>、'
        + '<b>y の行</b>のコマが<b>縦位置</b>を表しています。'
        + `${SAY.move}。`
        + 'まず 1 手動かして、左右が一緒に動くのを見てください。',
    done: (s) => s.moves >= 1,
  },
  {
    title: '1 手で動くのは 1 つの座標だけ',
    hint: '1 手で変えられるのは <b>どちらか一方の座標だけ</b>です。'
        + `${SAY.otherRow}、まだ動かしていない方の軸も動かしてみましょう。`,
    done: (s) => s.movedAxes.size >= 2,
  },
  {
    title: '壁にぶつかる',
    hint: '動ける向きには<b>矢印</b>が出ています。矢印の出ていない向きへ '
        + `${SAY.tryPush}。迷路の壁に阻まれて動けないことが分かります。`,
    done: (s) => s.bumped,
  },
  {
    title: '座標を減らす',
    hint: 'ゴールは右上ですが、まっすぐには行けません。'
        + `${SAY.goBack}。`
        + '迷路では左か下へ戻ることになります。',
    done: (s) => s.wentBack,
  },
  {
    title: 'ゴールへ',
    hint: '<b>両方のコマをいちばん右</b>へ運べばクリアです。'
        + '迷路では右上の <b>G</b> に着くことと同じです。',
    done: (s) => s.won,
  },
];

class Tutorial {
  constructor() {
    this.canvas = $('maze');
    this.movedAxes = new Set();
    this.bumped = false;
    this.wentBack = false;
    this.selected = 0;
    this.board = new CoordBoard($('board'), {
      rank: RANK, width: WIDTH,
      onMove: (axis, sign) => this.move(axis, sign),
      onSelect: (axis) => this.select(axis),
    });
    this.#initEvents();
    this.newPuzzle('GUIDE');
  }

  #initEvents() {
    $('btn-undo').addEventListener('click', () => this.undo());
    $('btn-reset').addEventListener('click', () => this.requestReset());
    $('btn-hint').addEventListener('click', () => this.hint());
    $('btn-new').addEventListener('click', () => this.newPuzzle(randomSeedString()));
    $('btn-close').addEventListener('click', () => $('done').classList.add('hidden'));

    this.canvas.addEventListener('click', (e) => {
      const r = this.canvas.getBoundingClientRect();
      // 画面が狭いと絵は縮めて表示される。押された点を元の寸法に戻してから読む。
      const scale = r.width / (PAD * 2 + CS * WIDTH);
      const x = Math.floor(((e.clientX - r.left) / scale - PAD) / CS);
      const y = WIDTH - 1 - Math.floor(((e.clientY - r.top) / scale - PAD) / CS);
      if (x < 0 || x >= WIDTH || y < 0 || y >= WIDTH) return;
      const dx = x - this.pos[0], dy = y - this.pos[1];
      if (Math.abs(dx) + Math.abs(dy) !== 1) return;
      if (dx !== 0) this.move(0, dx); else this.move(1, dy);
    });

    // COORD MAZE とまったく同じ操作にする。
    // (迷路側の上下左右に割り当てると、本編に移ったときに操作を覚え直すことになる)
    window.addEventListener('keydown', (e) => {
      // 確認ダイアログが開いている間は盤面を操作しない。
      if (isDialogOpen()) return;
      switch (e.code) {
        case 'ArrowUp': case 'KeyW': this.select((this.selected + RANK - 1) % RANK); break;
        case 'ArrowDown': case 'KeyS': this.select((this.selected + 1) % RANK); break;
        case 'ArrowRight': case 'KeyD': this.move(this.selected, 1); break;
        case 'ArrowLeft': case 'KeyA': this.move(this.selected, -1); break;
        case 'Digit1': this.select(0); break;
        case 'Digit2': this.select(1); break;
        case 'KeyZ': this.undo(); break;
        case 'KeyR': this.requestReset(); break;
        case 'KeyH': this.hint(); break;
        case 'KeyN': this.newPuzzle(randomSeedString()); break;
        default: return;
      }
      e.preventDefault();
    });
  }

  // ------------------------------------------------------------------ 状態

  newPuzzle(seedText) {
    $('done').classList.add('hidden');
    const puzzle = makeCoordPuzzle({ rank: RANK, width: WIDTH, seedText });
    this.maze = puzzle.maze;
    this.goal = this.maze.size - 1;
    this.visited = new Set();
    this.reset();
  }

  get cell() { return this.maze.index(this.pos); }

  reset() {
    this.pos = [0, 0];
    this.history = [];
    this.moves = 0;
    this.won = false;
    this.blockedEdge = null;
    // 本編と同じく、通った印も消してまっさらにする
    this.visited = new Set([0]);
    this.render();
  }

  select(axis) {
    this.selected = axis;
    this.render();
  }

  /** ボタンと R キーから呼ぶ「最初から」。進めた手があるときだけ確認する。 */
  async requestReset() {
    if (this.moves === 0) { this.reset(); return; }
    const ok = await confirmDialog({
      title: '最初からやり直しますか？',
      body: `いま ${this.moves} 手まで進んでいます。スタート地点に戻り、手数と`
          + '通ったことのある印が消えます（迷路そのものは同じままです）。',
      okLabel: '最初からにする',
    });
    if (ok) this.reset();
  }

  move(axis, sign) {
    if (this.won) return;
    this.selected = axis;
    if (!this.maze.isOpen(this.cell, axis, sign)) {
      const c = this.pos[axis] + sign;
      // 盤の外は「壁にぶつかった」とは扱わない (そこには壁も迷路もない)。
      if (c >= 0 && c < WIDTH) {
        sound.blocked();
        this.bumped = true;
        this.blockedEdge = { x: this.pos[0], y: this.pos[1], axis, sign };
        this.board.bump(axis);
        this.render();
        setTimeout(() => { this.blockedEdge = null; this.render(); }, 420);
      }
      return;
    }
    this.pos[axis] += sign;
    this.moves++;
    this.movedAxes.add(axis);
    if (sign < 0) this.wentBack = true;
    this.history.push({ axis, sign });
    this.visited.add(this.cell);
    sound.move(axis, sign);
    if (this.pos[0] === WIDTH - 1 && this.pos[1] === WIDTH - 1) { this.won = true; sound.win(); }
    this.render();
    if (this.won) setTimeout(() => $('done').classList.remove('hidden'), 500);
  }

  undo() {
    if (this.history.length === 0) return;
    const last = this.history.pop();
    this.pos[last.axis] -= last.sign;
    this.moves = Math.max(0, this.moves - 1);
    this.won = false;
    sound.undo();
    this.render();
  }

  hint() {
    const step = this.maze.nextStep(this.cell, this.goal);
    if (!step) return;
    const [axis, sign] = step;
    sound.hint();
    this.board.flash(axis, this.pos[axis] + sign);
    this.hintMove = { axis, sign, until: performance.now() + 2600 };
    this.render();
    setTimeout(() => { this.hintMove = null; this.render(); }, 2700);
  }

  // ------------------------------------------------------------------ 描画

  candidates() {
    const here = this.cell;
    const out = [];
    for (let a = 0; a < RANK; a++) {
      for (const sign of [1, -1]) {
        const to = this.maze.neighbor(here, a, sign);
        if (to >= 0) out.push({ axis: a, sign, seen: this.visited.has(to) });
      }
    }
    return out;
  }

  render() {
    const cand = this.candidates();
    this.board.render({ pos: this.pos, selected: this.selected, candidates: cand });
    this.#drawMaze(cand);

    $('moves').textContent = `${this.moves}`;
    $('coord').textContent = `(${this.pos.join(', ')})`;
    $('selected').textContent = axisName(this.selected);
    $('selected').style.color = axisColor(this.selected, RANK);
    this.#renderSteps();
  }

  #renderSteps() {
    const state = this;
    let current = STEPS.findIndex((s) => !s.done(state));
    // 手順がひとつ進んだ瞬間だけ鳴らす (クリアの音と重ならないようにする)
    if (this.lastStep !== undefined && current > this.lastStep && current >= 0 && !this.won) sound.chime();
    this.lastStep = current;
    const list = $('steplist');
    list.innerHTML = '';
    STEPS.forEach((s, k) => {
      const li = document.createElement('li');
      li.textContent = s.title;
      li.className = s.done(state) ? 'ok' : k === current ? 'now' : '';
      list.appendChild(li);
    });
    $('instruction').innerHTML = current < 0
      ? 'すべて完了です。左右がぴたりと対応しているのが見えていれば、もう読めます。'
      : STEPS[current].hint;
  }

  #drawMaze(cand) {
    const cv = this.canvas;
    const size = PAD * 2 + CS * WIDTH;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = size * dpr;
    cv.height = size * dpr;
    cv.style.width = `${size}px`;
    cv.style.height = `${size}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);

    const sx = (x) => PAD + x * CS;
    const sy = (y) => PAD + (WIDTH - 1 - y) * CS;   // y は上向き
    const mid = (v) => v + CS / 2;

    // マスの下地 (通ったことのあるマスは少し明るく)
    for (let y = 0; y < WIDTH; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const seen = this.visited.has(this.maze.index([x, y]));
        g.fillStyle = seen ? 'rgba(130,170,240,0.10)' : 'rgba(130,170,240,0.025)';
        g.fillRect(sx(x) + 1, sy(y) + 1, CS - 2, CS - 2);
      }
    }

    // 座標の対応を示す補助線。左の表の行と同じ色で、
    // それぞれ自分の目盛りの側にだけ伸ばして「この数字がこの位置」と読ませる。
    g.lineWidth = CS - 8;
    g.strokeStyle = this.selected === 0 ? BAND_X_ON : BAND_X;
    g.beginPath();
    g.moveTo(mid(sx(this.pos[0])), PAD);
    g.lineTo(mid(sx(this.pos[0])), size - 9);
    g.stroke();
    g.strokeStyle = this.selected === 1 ? BAND_Y_ON : BAND_Y;
    g.beginPath();
    g.moveTo(9, mid(sy(this.pos[1])));
    g.lineTo(size - PAD, mid(sy(this.pos[1])));
    g.stroke();

    // スタートとゴール
    g.fillStyle = 'rgba(111,240,255,0.13)';
    g.fillRect(sx(0) + 1, sy(0) + 1, CS - 2, CS - 2);
    // ゴールは恒星。まわりに淡い光をまとわせる
    const gx = mid(sx(WIDTH - 1)), gy = mid(sy(WIDTH - 1));
    const halo = g.createRadialGradient(gx, gy, 2, gx, gy, CS * 0.75);
    halo.addColorStop(0, 'rgba(255,217,138,0.34)');
    halo.addColorStop(1, 'rgba(255,217,138,0)');
    g.fillStyle = halo;
    g.fillRect(sx(WIDTH - 1) - CS * 0.3, sy(WIDTH - 1) - CS * 0.3, CS * 1.6, CS * 1.6);
    // 恒星の本体: 白い芯と金色の光球、短い光条 (左の表のゴール列と同じ絵)
    const core = g.createRadialGradient(gx, gy, 0, gx, gy, CS * 0.34);
    core.addColorStop(0, '#fffbea');
    core.addColorStop(0.35, '#ffe3a0');
    core.addColorStop(0.7, 'rgba(255,186,84,0.7)');
    core.addColorStop(1, 'rgba(255,140,50,0)');
    g.fillStyle = core;
    g.beginPath(); g.arc(gx, gy, CS * 0.34, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(255,217,138,0.35)';
    g.lineWidth = 1.2;
    g.beginPath();
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      g.moveTo(gx + Math.cos(ang) * CS * 0.2, gy + Math.sin(ang) * CS * 0.2);
      g.lineTo(gx + Math.cos(ang) * CS * (k % 2 ? 0.34 : 0.42), gy + Math.sin(ang) * CS * (k % 2 ? 0.34 : 0.42));
    }
    g.stroke();
    // スタートは小さな渦 (左の表のスタート列と同じ見立て)
    const s0x = mid(sx(0)), s0y = mid(sy(0));
    g.lineWidth = 1.4;
    for (let k = 0; k < 3; k++) {
      g.strokeStyle = k % 2 ? 'rgba(176,107,255,0.45)' : 'rgba(111,240,255,0.5)';
      g.beginPath();
      g.arc(s0x, s0y, CS * (0.12 + k * 0.09), k * 2.1, k * 2.1 + Math.PI * 1.3);
      g.stroke();
    }
    g.font = '600 13px ui-monospace, Menlo, monospace';
    g.textAlign = 'center'; g.textBaseline = 'middle';

    // 壁
    g.lineCap = 'round';
    g.lineWidth = 5;
    g.strokeStyle = 'rgba(138,176,238,0.72)';
    g.beginPath();
    for (let y = 0; y < WIDTH; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const i = this.maze.index([x, y]);
        const l = sx(x), r = l + CS, t = sy(y), b = t + CS;
        if (!this.maze.isOpen(i, 0, -1)) { g.moveTo(l, t); g.lineTo(l, b); }
        if (!this.maze.isOpen(i, 0, 1)) { g.moveTo(r, t); g.lineTo(r, b); }
        if (!this.maze.isOpen(i, 1, 1)) { g.moveTo(l, t); g.lineTo(r, t); }
        if (!this.maze.isOpen(i, 1, -1)) { g.moveTo(l, b); g.lineTo(r, b); }
      }
    }
    g.stroke();

    // ぶつかった壁を一瞬だけ赤くする
    if (this.blockedEdge) {
      const { x, y, axis, sign } = this.blockedEdge;
      const l = sx(x), r = l + CS, t = sy(y), b = t + CS;
      g.strokeStyle = '#ff5f7a';
      g.lineWidth = 7;
      g.beginPath();
      if (axis === 0 && sign < 0) { g.moveTo(l, t); g.lineTo(l, b); }
      if (axis === 0 && sign > 0) { g.moveTo(r, t); g.lineTo(r, b); }
      if (axis === 1 && sign > 0) { g.moveTo(l, t); g.lineTo(r, t); }
      if (axis === 1 && sign < 0) { g.moveTo(l, b); g.lineTo(r, b); }
      g.stroke();
    }

    // 動ける向きの矢印 (まだ行っていない先は塗り、通った先は輪郭だけ)
    for (const c of cand) {
      const nx = this.pos[0] + (c.axis === 0 ? c.sign : 0);
      const ny = this.pos[1] + (c.axis === 1 ? c.sign : 0);
      const cx = mid(sx(nx)), cy = mid(sy(ny));
      const dx = c.axis === 0 ? c.sign : 0;
      const dy = c.axis === 1 ? -c.sign : 0;   // 画面の上下は y と逆
      const s = 9;
      g.beginPath();
      g.moveTo(cx + dx * s, cy + dy * s);
      g.lineTo(cx - dx * s - dy * s * 0.8, cy - dy * s - dx * s * 0.8);
      g.lineTo(cx - dx * s + dy * s * 0.8, cy - dy * s + dx * s * 0.8);
      g.closePath();
      const col = c.axis === 0 ? COL_X : COL_Y;
      const hinted = this.hintMove && this.hintMove.axis === c.axis && this.hintMove.sign === c.sign;
      if (hinted) { g.fillStyle = '#ffd98a'; g.fill(); }
      else if (c.seen) { g.strokeStyle = col; g.lineWidth = 1.6; g.globalAlpha = 0.5; g.stroke(); g.globalAlpha = 1; }
      else { g.fillStyle = col; g.fill(); }
    }

    // 自分。2 つの座標をまとめた 1 つの天体なので、x と y の色を混ぜた惑星にする
    const px = mid(sx(this.pos[0])), py = mid(sy(this.pos[1]));
    const R = 13;
    const body = g.createLinearGradient(px - R, py - R, px + R, py + R);
    body.addColorStop(0.15, COL_X);
    body.addColorStop(0.9, COL_Y);
    g.beginPath();
    g.arc(px, py, R, 0, Math.PI * 2);
    g.fillStyle = body;
    g.shadowColor = 'rgba(200,230,255,0.9)';
    g.shadowBlur = 20;
    g.fill();
    g.shadowBlur = 0;
    // 光の当たり方 (左上が明るく、右下が夜の側)
    const shade = g.createRadialGradient(px - R * 0.4, py - R * 0.45, 1, px, py, R * 1.1);
    shade.addColorStop(0, 'rgba(255,255,255,0.7)');
    shade.addColorStop(0.35, 'rgba(255,255,255,0.08)');
    shade.addColorStop(1, 'rgba(2,3,10,0.32)');
    g.fillStyle = shade;
    g.fill();

    // 目盛り (左の表の列番号と対応)
    g.font = '11px ui-monospace, Menlo, monospace';
    for (let k = 0; k < WIDTH; k++) {
      g.fillStyle = k === this.pos[0] ? COL_X : 'rgba(123,139,171,0.72)';
      g.fillText(`${k}`, mid(sx(k)), size - PAD / 2);
      g.fillStyle = k === this.pos[1] ? COL_Y : 'rgba(123,139,171,0.72)';
      g.fillText(`${k}`, PAD / 2, mid(sy(k)));
    }
    g.fillStyle = COL_X;
    g.fillText('x', mid(sx(WIDTH - 1)) + CS * 0.62, size - PAD / 2);
    g.fillStyle = COL_Y;
    g.fillText('y', PAD / 2, mid(sy(WIDTH - 1)) - CS * 0.62);
  }
}

installStarfield();
armSound();
installShare();
installOffline();
window.tutorial = new Tutorial();
