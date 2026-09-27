import { mulberry32, hashSeed } from './rng.js?v=fe00680b';

/**
 * 階層的な暗黙の迷路 (大きい盤面用)。
 *
 * MazeND は全状態ぶんの壁を配列で持つので、120 万状態あたりが限界だった
 * (10 次元 10 マス = 100 億状態では、壁だけで数 GB になる)。こちらは壁を持たず、
 * 聞かれたところだけをその場で作る。
 *
 * 作り方:
 *   - 盤面 (区画) を各軸で半分に割って、子の区画に分ける (子は最大 2^次元数 = 1024 個)
 *   - 子どうしのつながり方は、子の格子の上の全域木で決める (1024 頂点なので一瞬で作れる)
 *   - 木でつながっている隣の子の間には、境界面のどこか 1 か所にだけ扉を開ける
 *   - 子の区画の中も同じように割っていき、十分小さくなったらふつうの迷路にする
 * 木の中に木を入れて、つなぎ目を 1 か所ずつにしているので、全体も全域木になる。
 * つまり MazeND と同じく「すべての状態に行ける、輪のない迷路」。
 *
 * 最短手数の爆発を抑える:
 *   素直に作ると、ゴールまでの道は階層ごとに何倍にも伸びる (子の木の中の道 × 子の中の道 × …)。
 *   そこで、スタートからゴールへの道が通る区画だけは、道筋を先に引いてから木を作る。
 *   道筋は「ゴールへ近づく向きに偏らせたループ消去ランダムウォーク」で引く。偏り (bias) で
 *   遠回りの量を調節できる。残りの辺は Kruskal でランダムに足すので、道筋以外は
 *   ふつうの迷路のまま (木に道筋を先に入れておけば、その 2 点を結ぶ道は必ずその道筋になる)。
 *
 * 遊べる大きさにする (本道, corridor):
 *   100 億状態の迷路では、道筋から一度でも大きな脇道に迷い込むと、その先は何千万状態もあって
 *   手探りでは戻ってこられない。そこで道筋の通る区画では、道筋に触れない辺を先に全部つないでから
 *   道筋に触れる辺を足す。すると道筋から脇へ分かれる入口は、区画ごとにほぼ 1 か所になる。
 *   その入口は「次の手が座標を増やす向きの道筋のマス」から「座標を減らす向き」に置く
 *   (右へ進みたい人は、先に本道を選ぶ)。これで分かれ道はずっと少なくなるが、
 *   道筋の遠回り (左へ戻る手) はそのまま残るので、考えずに右へ押すだけでは解けない。
 *
 * 区画ごとの作り方は、シードと区画の位置だけから決まる (どの順に聞いても同じ迷路になる)。
 */

const LEAF_MAX = 4096;     // これ以下の大きさの区画は、ふつうの迷路として作る
const KEEP_TREES = 400;    // 作った木を覚えておく数。超えたら古いものから捨てる (また聞かれたら作り直す)

export class HierMaze {
  /**
   * @param dims 各次元のマス数 / seed 32bit のシード
   * @param bias 道筋を引くときに、ゴールへ近づく手を選ぶ確率 (大きいほど遠回りが減る)
   * @param align 道筋の上の扉を、ゴール側の端にそろえる確率 (大きいほど遠回りが減る)
   * @param corridor 本道の強さ (0〜1、true は 1)。道筋から脇へ分かれる入口を、区画ごとにほぼ 1 か所に絞る
   * @param fewSplits 子が次の階層で葉になれるなら、長い軸から必要な本数だけ割る。
   *   全部の軸を半分にすると、10 次元では葉が各軸 2 マスになり、葉の中の道筋が短すぎて
   *   本道のマスに分かれ道が 2 つできることがある (大きい脇道に迷い込む原因になる)
   * @param leafMax これ以下の区画をふつうの迷路にする (テストで小さくして、階層を深くする)
   */
  constructor({ dims, seed, bias = 0.7, align = 0, corridor = false, leafMax = LEAF_MAX, fewSplits = false }) {
    this.dims = [...dims];
    this.rank = this.dims.length;
    this.strides = [];
    let stride = 1;
    for (const n of this.dims) { this.strides.push(stride); stride *= n; }
    this.size = stride;
    this.start = 0;
    this.goal = stride - 1;
    this.reachable = stride;
    this.seed = seed;
    this.bias = bias;
    this.align = align;
    this.corridor = corridor === true ? 1 : corridor || 0;
    this.fewSplits = fewSplits;
    this.leafMax = leafMax;
    this.built = new Set();    // 木を持っている区画 (作った順)。長く遊んでもメモリが膨らまないように
    this.root = new Block(this, null, Array(this.rank).fill(0), [...this.dims]);
    this.root.ends = [Array(this.rank).fill(0), this.dims.map((n) => n - 1)];
  }

  index(coords) {
    let i = 0;
    for (let a = 0; a < this.rank; a++) i += coords[a] * this.strides[a];
    return i;
  }

  coord(i, axis) {
    return Math.floor(i / this.strides[axis]) % this.dims[axis];
  }

  coords(i) {
    const out = new Array(this.rank);
    for (let a = 0; a < this.rank; a++) out[a] = this.coord(i, a);
    return out;
  }

  isOpen(i, axis, sign) {
    const u = this.coords(i);
    const c = u[axis] + sign;
    if (c < 0 || c >= this.dims[axis]) return false;
    const v = u.slice();
    v[axis] = c;
    return this.#edge(u, v);
  }

  neighbor(i, axis, sign) {
    return this.isOpen(i, axis, sign) ? i + sign * this.strides[axis] : -1;
  }

  /** 隣り合う 2 マス u, v の間が通れるか。 */
  #edge(u, v) {
    let b = this.root;
    while (!b.isLeaf) {
      const cu = b.childIndexOf(u), cv = b.childIndexOf(v);
      if (cu !== cv) {
        // 別々の子にまたがる: 子どうしが木でつながっていて、しかもここが扉なら通れる
        if (!treeEdge(b.tree, cu, cv)) return false;
        const d = b.door(cu, cv);
        return same(d.get(cu), u) && same(d.get(cv), v);
      }
      b = b.child(cu);
    }
    return treeEdge(b.tree, b.localIndex(u), b.localIndex(v));
  }

  /** ゴールへ向かう次の 1 手 [軸, 向き]。ゴールにいれば null。 */
  nextStep(from, to = this.goal) {
    if (from === to) return null;
    const x = this.coords(from), t = this.coords(to);
    const y = this.#step(this.root, x, t);
    for (let a = 0; a < this.rank; a++) if (y[a] !== x[a]) return [a, y[a] - x[a]];
    return null;
  }

  /** 区画 b の中で、x から t へ向かう次のマス (x ≠ t、どちらも b の中)。 */
  #step(b, x, t) {
    for (;;) {
      if (b.isLeaf) {
        const prev = b.towards(b.localIndex(t));
        return b.globalCoords(prev[b.localIndex(x)]);
      }
      const cx = b.childIndexOf(x), ct = b.childIndexOf(t);
      if (cx === ct) { b = b.child(cx); continue; }
      // 子の木の上で、t のいる子へ向かう次の子。その扉が次の目標になる
      const cn = b.towards(ct)[cx];
      const d = b.door(cx, cn);
      const out = d.get(cx);
      if (same(out, x)) return d.get(cn).slice();
      t = out;
      b = b.child(cx);
    }
  }

  /**
   * スタートからゴールまでの最短手数。道筋を引いた区画をたどって足し合わせる
   * (全体を幅優先で探すことはできないので)。
   */
  solutionLength() {
    if (this.par === undefined) this.par = this.root.pathLength();
    return this.par;
  }

  /** from から to への道 (状態 index の配列)。nextStep をたどるので、小さい盤面のテスト用。 */
  path(from, to = this.goal) {
    const out = [from];
    let cur = from;
    while (cur !== to) {
      const s = this.nextStep(cur, to);
      if (!s) return null;
      cur = cur + s[1] * this.strides[s[0]];
      out.push(cur);
      if (out.length > this.size + 1) return null;
    }
    return out;
  }
}

/**
 * 区画。lo 以上 hi 未満の直方体。
 * 大きい区画は子に分けて「子の格子の全域木」を持ち、小さい区画はマスの迷路そのものを持つ。
 */
class Block {
  constructor(maze, parent, lo, hi) {
    this.maze = maze;
    this.parent = parent;
    this.lo = lo;
    this.hi = hi;
    this.key = `${lo.join(',')}/${hi.join(',')}`;
    this.ends = null;          // 道筋の両端 (大域の座標)。道筋の通らない区画では null
    this.exitPlus = true;      // 道筋の出口から先の 1 手 (次の区画への扉) が座標を増やす向きか
    const rank = lo.length;
    let size = 1;
    for (let a = 0; a < rank; a++) size *= hi[a] - lo[a];
    this.size = size;
    this.isLeaf = size <= maze.leafMax;

    // 木を張る格子: 葉ならマスそのもの、そうでなければ子の並び (各軸 1 か 2)
    this.gdims = [];
    this.split = [];
    // どの軸を割るか。ふつうは長さ 2 以上の軸を全部割る。fewSplits のときは、
    // 子が次の階層で葉になれるなら、長い軸から必要な本数だけ割る (葉が細かくなりすぎないように)
    const cut = new Array(rank).fill(false);
    for (let a = 0; a < rank; a++) cut[a] = hi[a] - lo[a] >= 2;
    if (!this.isLeaf && maze.fewSplits) {
      let all = 1;
      for (let a = 0; a < rank; a++) all *= cut[a] ? Math.ceil((hi[a] - lo[a]) / 2) : hi[a] - lo[a];
      if (all <= maze.leafMax) {
        const order = [...Array(rank).keys()].sort((p, q) => (hi[q] - lo[q]) - (hi[p] - lo[p]) || p - q);
        cut.fill(false);
        let child = size;
        for (const a of order) {
          if (child <= maze.leafMax) break;
          const n = hi[a] - lo[a];
          if (n < 2) break;
          cut[a] = true;
          child = (child / n) * Math.ceil(n / 2);
        }
      }
    }
    for (let a = 0; a < rank; a++) {
      const n = hi[a] - lo[a];
      if (this.isLeaf) this.gdims.push(n);
      else if (cut[a]) { this.gdims.push(2); this.split.push(lo[a] + Math.ceil(n / 2)); }
      else { this.gdims.push(1); this.split.push(hi[a]); }
    }
    this.gstrides = [];
    let s = 1;
    for (const n of this.gdims) { this.gstrides.push(s); s *= n; }
    this.gsize = s;
    this.children = new Map();
    this.doors = new Map();
    this.toward = new Map();
    this._tree = null;
  }

  childIndexOf(c) {
    let i = 0;
    for (let a = 0; a < c.length; a++) if (c[a] >= this.split[a]) i += this.gstrides[a];
    return i;
  }

  localIndex(c) {
    let i = 0;
    for (let a = 0; a < c.length; a++) i += (c[a] - this.lo[a]) * this.gstrides[a];
    return i;
  }

  globalCoords(li) {
    const out = new Array(this.lo.length);
    for (let a = 0; a < out.length; a++) {
      out[a] = this.lo[a] + (Math.floor(li / this.gstrides[a]) % this.gdims[a]);
    }
    return out;
  }

  /** 子の区画 (index ci) の範囲。 */
  childBox(ci) {
    const lo = [], hi = [];
    for (let a = 0; a < this.lo.length; a++) {
      const bit = Math.floor(ci / this.gstrides[a]) % this.gdims[a];
      if (this.gdims[a] === 1) { lo.push(this.lo[a]); hi.push(this.hi[a]); }
      else if (bit === 0) { lo.push(this.lo[a]); hi.push(this.split[a]); }
      else { lo.push(this.split[a]); hi.push(this.hi[a]); }
    }
    return { lo, hi };
  }

  child(ci) {
    let c = this.children.get(ci);
    if (c) return c;
    const { lo, hi } = this.childBox(ci);
    c = new Block(this.maze, this, lo, hi);
    // 道筋がこの子を通るなら、子の中の道筋の両端 (入口と出口) を渡す
    const tree = this.tree;
    if (tree.path) {
      const p = tree.pathPos.get(ci);
      if (p !== undefined) {
        const k = tree.path.length - 1;
        const entry = p === 0 ? this.ends[0] : this.door(tree.path[p - 1], ci).get(ci);
        const exit = p === k ? this.ends[1] : this.door(ci, tree.path[p + 1]).get(ci);
        c.ends = [entry, exit];
        // 出口の先の手の向き: 最後の子なら親の出口と同じ、そうでなければ次の子へくぐる向き
        c.exitPlus = p === k ? this.exitPlus : tree.path[p + 1] > ci;
      }
    }
    this.children.set(ci, c);
    return c;
  }

  /** 木 (葉ならマスの迷路、そうでなければ子の格子の全域木)。初めて使うときに作る。 */
  get tree() {
    if (this._tree) return this._tree;
    const rng = mulberry32(hashSeed(`${this.maze.seed}|tree|${this.key}`));
    let ends = null;
    if (this.ends) {
      ends = this.isLeaf
        ? [this.localIndex(this.ends[0]), this.localIndex(this.ends[1])]
        : [this.childIndexOf(this.ends[0]), this.childIndexOf(this.ends[1])];
    }
    this._tree = buildTree(this.gdims, this.gstrides, this.gsize, rng, ends, this.maze.bias,
      this.maze.corridor, this.exitPlus);
    // 古い木を捨てる。区画の木はシードと位置だけから決まるので、捨てても同じものを作り直せる
    const built = this.maze.built;
    built.delete(this);
    built.add(this);
    if (built.size > KEEP_TREES) {
      const old = built.values().next().value;
      built.delete(old);
      old._tree = null;
      old.toward.clear();
    }
    return this._tree;
  }

  /**
   * 隣り合う子 a, b の間の扉。返すのは Map { 子 index → その子の側のマス (大域の座標) }。
   * 境界面の上の位置は、区画と子の組から決まる乱数で選ぶ。
   */
  door(a, b) {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const id = lo * this.gsize + hi;
    let d = this.doors.get(id);
    if (d) return d;
    const rank = this.lo.length;
    const axis = this.gstrides.findIndex((s, k) => this.gdims[k] === 2 && hi - lo === s);
    const rng = mulberry32(hashSeed(`${this.maze.seed}|door|${this.key}|${lo}`));
    const box = this.childBox(lo);
    // 道筋の上の扉は、確率 align で各軸を道筋の終点 (ゴール側) にそろえる。
    // 扉が境界面のばらばらな位置にあると、子の中を斜めに横切る分が階層ごとに積み重なって
    // 最短手数が伸びすぎるため。
    const tree = this.ends ? this.tree : null;
    const onPath = tree && tree.pathPos.has(lo) && tree.pathPos.has(hi)
      && Math.abs(tree.pathPos.get(lo) - tree.pathPos.get(hi)) === 1;
    const cLo = new Array(rank);
    for (let k = 0; k < rank; k++) {
      const r = rng(), q = rng();
      if (k === axis) cLo[k] = this.split[k] - 1;
      else if (onPath && q < this.maze.align) cLo[k] = Math.min(box.hi[k] - 1, Math.max(box.lo[k], this.ends[1][k]));
      else cLo[k] = box.lo[k] + Math.floor(r * (box.hi[k] - box.lo[k]));
    }
    const cHi = cLo.slice();
    cHi[axis] = this.split[axis];
    d = new Map([[lo, cLo], [hi, cHi]]);
    this.doors.set(id, d);
    return d;
  }

  /**
   * 木の上で target へ向かう「1 つ先」の表 (prev[i] = i から target へ向かう次の頂点)。
   * 同じ target を何度も聞かれるので、区画ごとに少しだけ覚えておく。
   */
  towards(target) {
    let prev = this.toward.get(target);
    if (prev) return prev;
    prev = bfsToward(this.tree, this.gdims, this.gstrides, this.gsize, target);
    if (this.toward.size > 8) this.toward.delete(this.toward.keys().next().value);
    this.toward.set(target, prev);
    return prev;
  }

  /** この区画の中の、道筋の長さ (両端 ends の間の手数)。 */
  pathLength() {
    const tree = this.tree;
    if (this.isLeaf) return tree.path.length - 1;
    let n = tree.path.length - 1;     // 扉をくぐる手
    for (const ci of tree.path) {
      const c = this.child(ci);
      n += c.pathLength();
      // 道筋の長さを数え終えた子は、中身を捨ててよい (遊ぶときにまた作り直せる)
      this.children.delete(ci);
    }
    return n;
  }
}

// ------------------------------------------------------------------ 小さい格子の木

/** 木で i と j (隣り合う頂点) がつながっているか。 */
function treeEdge(tree, i, j) {
  const lo = Math.min(i, j);
  const axis = tree.axisOf(Math.abs(i - j));
  return axis >= 0 && tree.links[axis][lo] === 1;
}

const same = (p, q) => {
  for (let a = 0; a < p.length; a++) if (p[a] !== q[a]) return false;
  return true;
};

/**
 * 小さい格子 (dims) の全域木を作る。
 * ends = [s, t] があれば、先に s から t への道筋を引いて木に入れ、残りを Kruskal で足す。
 * 返す木: links[axis][i] = 1 なら i と i+strides[axis] がつながっている。path は道筋 (頂点の列)。
 */
function buildTree(dims, strides, size, rng, ends, bias, corridor = false, exitPlus = true) {
  const rank = dims.length;
  const links = dims.map(() => new Uint8Array(size));
  const parent = new Int32Array(size);
  for (let i = 0; i < size; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
    return a;
  };
  const coord = (i, a) => Math.floor(i / strides[a]) % dims[a];
  const join = (i, j) => {
    const lo = Math.min(i, j);
    const axis = strides.findIndex((s, a) => dims[a] > 1 && Math.abs(i - j) === s && coord(lo, a) + 1 < dims[a]);
    links[axis][lo] = 1;
    parent[find(i)] = find(j);
  };

  let path = null;
  if (ends) {
    path = biasedLoopErasedWalk(dims, strides, size, rng, ends[0], ends[1], bias);
    for (let k = 0; k + 1 < path.length; k++) join(path[k], path[k + 1]);
  }

  // 残りの辺を、ランダムな順に「輪にならない限り」足す (Kruskal)
  let count = 0;
  for (let a = 0; a < rank; a++) if (dims[a] > 1) count += size - size / dims[a];
  const edges = new Uint32Array(count);
  let n = 0;
  for (let i = 0; i < size; i++) {
    for (let a = 0; a < rank; a++) {
      if (coord(i, a) + 1 < dims[a]) edges[n++] = i * rank + a;
    }
  }
  for (let k = n - 1; k > 0; k--) {
    const j = (rng() * (k + 1)) | 0;
    const t = edges[k]; edges[k] = edges[j]; edges[j] = t;
  }
  const add = (k) => {
    const a = edges[k] % rank;
    const i = (edges[k] - a) / rank;
    const ri = find(i), rj = find(i + strides[a]);
    if (ri === rj) return;
    parent[ri] = rj;
    links[a][i] = 1;
  };
  if (corridor && path) {
    // 本道: 道筋に触れない辺を先に全部つないでから、道筋に触れる辺を足す。
    // 道筋のまわりが先に 1 つにまとまるので、道筋から脇へ分かれる入口はほぼ 1 か所になる。
    // 入口は「道筋のマスから見て座標を減らす向き」を先に試して、右へ進む人が迷い込みにくくする。
    // onPath[v] = 1: 道筋のマスで、次の手が座標を増やす向き / 2: 次の手が減らす向き
    const onPath = new Uint8Array(size);
    path.forEach((v, k) => {
      const plus = k + 1 < path.length ? path[k + 1] > v : exitPlus;
      onPath[v] = plus ? 1 : 2;
    });
    const best = [], back = [], fwd = [];
    for (let k = 0; k < n; k++) {
      const a = edges[k] % rank;
      const i = (edges[k] - a) / rank;
      const j = i + strides[a];
      // corridor が 1 より小さいときは、道筋に触れる辺の一部も先にふつうの順で足して、
      // 本道からの分かれ道を少し残す (本道の強さの調節)
      if ((!onPath[i] && !onPath[j]) || rng() >= corridor) add(k);
      // 辺 (i, j) は i が小さい側。道筋のマスが j なら、脇道 i は座標を減らす向き。
      // いちばん良いのは「次の手が増やす向きの道筋のマス」から減らす向きに分かれる入口:
      // 右へ進む人は、先に本道を選ぶ
      else if (onPath[j] && !onPath[i]) (onPath[j] === 1 ? best : back).push(k);
      else fwd.push(k);
    }
    for (const k of best) add(k);
    for (const k of back) add(k);
    for (const k of fwd) add(k);
  } else {
    for (let k = 0; k < n; k++) add(k);
  }

  const axisOf = (diff) => {
    for (let a = 0; a < rank; a++) if (dims[a] > 1 && strides[a] === diff) return a;
    return -1;
  };
  const pathPos = new Map();
  if (path) path.forEach((v, k) => pathPos.set(v, k));
  return { links, path, pathPos, axisOf };
}

/**
 * s から t への、ゴールへ近づく向きに偏らせたループ消去ランダムウォーク。
 * 毎歩、確率 bias で「t に近づく手」から、それ以外は全部の手から選んで進み、
 * 自分の通った跡に戻ったら、そこから先を消す (輪を消す)。結果は自分と交わらない道になる。
 * bias = 1 なら最短の道、小さいほど遠回りの多い道。
 */
function biasedLoopErasedWalk(dims, strides, size, rng, s, t, bias) {
  const rank = dims.length;
  const pos = new Int32Array(size).fill(-1);
  const path = [s];
  pos[s] = 0;
  const coord = (i, a) => Math.floor(i / strides[a]) % dims[a];
  const toward = [], any = [];
  let cur = s;
  while (cur !== t) {
    toward.length = 0; any.length = 0;
    for (let a = 0; a < rank; a++) {
      const c = coord(cur, a), g = coord(t, a);
      if (c + 1 < dims[a]) { any.push(cur + strides[a]); if (g > c) toward.push(cur + strides[a]); }
      if (c > 0) { any.push(cur - strides[a]); if (g < c) toward.push(cur - strides[a]); }
    }
    const pool = toward.length && rng() < bias ? toward : any;
    const next = pool[(rng() * pool.length) | 0];
    if (pos[next] >= 0) {
      // 輪になった: next より後ろを消す
      for (let k = pos[next] + 1; k < path.length; k++) pos[path[k]] = -1;
      path.length = pos[next] + 1;
    } else {
      pos[next] = path.length;
      path.push(next);
    }
    cur = next;
  }
  return path;
}

/** 木の上で target から幅優先: prev[i] = i から target へ向かう次の頂点。 */
function bfsToward(tree, dims, strides, size, target) {
  const rank = dims.length;
  const prev = new Int32Array(size).fill(-1);
  const queue = new Int32Array(size);
  let head = 0, tail = 0;
  prev[target] = target;
  queue[tail++] = target;
  while (head < tail) {
    const i = queue[head++];
    for (let a = 0; a < rank; a++) {
      if (dims[a] === 1) continue;
      const c = Math.floor(i / strides[a]) % dims[a];
      if (c + 1 < dims[a] && tree.links[a][i] === 1) {
        const j = i + strides[a];
        if (prev[j] < 0) { prev[j] = i; queue[tail++] = j; }
      }
      if (c > 0 && tree.links[a][i - strides[a]] === 1) {
        const j = i - strides[a];
        if (prev[j] < 0) { prev[j] = i; queue[tail++] = j; }
      }
    }
  }
  return prev;
}
