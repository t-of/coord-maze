import { mulberry32 } from './rng.js?v=fe00680b';

/**
 * 任意の次元数の格子迷路。
 *
 * 部屋は dims = [n0, n1, ...] の格子。隣り合う部屋 (どれか 1 軸の座標が 1 違う)
 * の間に通路があるかどうかだけを持つ。生成は格子グラフ全体の最小全域木
 * (Kruskal 法) で、そのあと braid の確率で辺を戻してループを作る。
 *
 * 4 次元迷路ゲームの Maze4D と同じ作りだが、あちらは w 軸に重みの下駄を履かせる
 * などゲーム固有の都合が入っているので、こちらは素の格子として独立させてある。
 */
export class MazeND {
  constructor({ dims, seed, braid = 0.05 }) {
    this.dims = [...dims];
    this.rank = this.dims.length;
    this.strides = [];
    let stride = 1;
    for (const n of this.dims) {
      this.strides.push(stride);
      stride *= n;
    }
    this.size = stride;
    // 全域木なのでどの状態にも行ける。始点は全次元 0、終点は全次元 n-1。
    this.start = 0;
    this.goal = stride - 1;
    this.reachable = stride;
    this.seed = seed;
    this.braid = braid;
    // links[axis][i] === 1 なら部屋 i と (i + strides[axis]) の間に通路がある。
    this.links = this.dims.map(() => new Uint8Array(this.size));
    this.rng = mulberry32(seed);
    this.#generate();
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
    const c = this.coord(i, axis);
    if (sign > 0) {
      if (c + 1 >= this.dims[axis]) return false;
      return this.links[axis][i] === 1;
    }
    if (c <= 0) return false;
    return this.links[axis][i - this.strides[axis]] === 1;
  }

  neighbor(i, axis, sign) {
    if (!this.isOpen(i, axis, sign)) return -1;
    return i + sign * this.strides[axis];
  }

  #generate() {
    const rng = this.rng;
    const { rank, size, strides, dims } = this;

    // 辺は (部屋 i, 軸 a) を id = i * rank + a に詰めた整数ひとつで表す。
    // 重みを振ってソートする代わりにシャッフルする: 一様乱数の重みで
    // ソートした順序はランダムな順列と同じなので、出来上がる全域木の分布は変わらない。
    // 辺をオブジェクトで持つと状態数 25 万で 100MB 近く食うため、型付き配列にしている。
    let count = 0;
    for (let a = 0; a < rank; a++) count += size - size / dims[a];
    const edges = new Uint32Array(count);
    let n = 0;
    for (let i = 0; i < size; i++) {
      for (let a = 0; a < rank; a++) {
        if (Math.floor(i / strides[a]) % dims[a] + 1 >= dims[a]) continue;
        edges[n++] = i * rank + a;
      }
    }
    for (let k = n - 1; k > 0; k--) {
      const j = (rng() * (k + 1)) | 0;
      const t = edges[k]; edges[k] = edges[j]; edges[j] = t;
    }

    const parent = new Int32Array(size);
    for (let i = 0; i < size; i++) parent[i] = i;
    const find = (a) => {
      while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
      return a;
    };

    const braid = this.braid;
    for (let k = 0; k < n; k++) {
      const id = edges[k];
      const a = id % rank;
      const i = (id - a) / rank;
      const ra = find(i);
      const rb = find(i + strides[a]);
      if (ra === rb) {
        // 全域木には要らない辺。braid の確率だけ戻してループを作る。
        if (braid > 0 && rng() < braid) this.links[a][i] = 1;
        continue;
      }
      parent[ra] = rb;
      this.links[a][i] = 1;
    }
  }

  bfs(from) {
    const dist = new Int32Array(this.size).fill(-1);
    const prev = new Int32Array(this.size).fill(-1);
    const queue = new Int32Array(this.size);
    let head = 0, tail = 0;
    dist[from] = 0;
    queue[tail++] = from;
    while (head < tail) {
      const i = queue[head++];
      for (let axis = 0; axis < this.rank; axis++) {
        for (const sign of [1, -1]) {
          const j = this.neighbor(i, axis, sign);
          if (j < 0 || dist[j] >= 0) continue;
          dist[j] = dist[i] + 1;
          prev[j] = i;
          queue[tail++] = j;
        }
      }
    }
    return { dist, prev };
  }

  /** from から to への最短経路 (部屋 index の配列)。到達不能なら null。 */
  path(from, to) {
    const { dist, prev } = this.bfs(from);
    if (dist[to] < 0) return null;
    const out = [];
    for (let cur = to; cur >= 0; cur = prev[cur]) {
      out.push(cur);
      if (cur === from) break;
    }
    return out.reverse();
  }

  /** 次の 1 手だけ知りたいとき: to へ向かうために動かす [軸, 向き]。 */
  nextStep(from, to) {
    const p = this.path(from, to);
    if (!p || p.length < 2) return null;
    const diff = p[1] - p[0];
    for (let axis = 0; axis < this.rank; axis++) {
      if (Math.abs(diff) === this.strides[axis] && this.coord(p[0], axis) !== this.coord(p[1], axis)) {
        return [axis, Math.sign(diff)];
      }
    }
    return null;
  }
}
