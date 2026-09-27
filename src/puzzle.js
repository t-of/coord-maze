import { MazeND } from './mazend.js?v=fe00680b';
import { hashSeed } from './rng.js?v=fe00680b';
import { HierMaze } from './hmaze.js?v=fe00680b';

/**
 * 座標迷路 (COORD MAZE) の出題を作る。
 *
 * どちらの迷路も**すべての状態に行ける**、輪のないふつうの迷路にしてある。
 *   - 120 万状態まで: 格子グラフ全体の最小全域木 (MazeND)。壁を全部配列で持つ
 *   - それより大きい盤面: 階層的な暗黙の迷路 (HierMaze)。壁を持たず、聞かれたところだけ作る
 * 小さい盤面を MazeND のままにしているのは、同じシードで前と同じ迷路を出すため
 * (記録の「もう一度」や、保存してある続きがそのまま遊べる)。
 */

/**
 * MazeND で作る上限。壁を状態数ぶんの配列で持ち、生成もまとめて行うので、
 * これを超えるとメモリと時間が足りなくなる (7 次元 7 マス = 82 万状態で生成 130ms)。
 */
export const EXPLICIT_MAX = 1_200_000;

/** ふつうに選べる大きさ。この範囲 (10 次元 10 マス = 100 億状態まで) は、すべての組み合わせを選べる。 */
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
export const WIDTHS = [2, 3, 4, 5, 6, 7, 8, 9, 10];
export const MAX_STATES = 10_000_000_000;

/**
 * 「もっと大きく」で増える大きさ。
 * 状態の番号を JavaScript の数値で持っているので、正確に表せる 2^53 (約 9,000 兆) を超えられない。
 * その手前の 5,000 兆までにしてある (12 次元 20 マス・10 次元 36 マス・5 次元 1000 マスなど)。
 * このあたりは生成に数秒かかり、最短手数も数万〜数十万手になる。
 */
export const MORE_RANKS = [11, 12];
export const MORE_WIDTHS = [12, 15, 20, 25, 30, 36, 50, 90, 100, 200, 400, 1000];
export const MORE_MAX_STATES = 5_000_000_000_000_000;

/**
 * HierMaze の作り方。道筋を先に引くだけの、素直な作り方にしてある
 * (MazeND と同じく、盤面が大きいほど難しい)。
 *   bias  … 道筋を引くとき、ゴールへ近づく手を選ぶ確率
 * 遊びやすくする設定 (扉をそろえる align・本道 corridor・fewSplits) も hmaze.js にあるが、
 * 大きい盤面が今までの盤面より易しくなってしまうので使っていない (README の「大きい盤面」参照)。
 */
export const HIER_OPTIONS = { bias: 0.7 };

export const statesOf = (rank, width) => width ** rank;

/**
 * 全次元 0 から全次元 width-1 へ運ぶパズルなので、最短手数が直線距離
 * (= rank * (width-1)) と同じだと「全部まとめて右に押すだけ」で解けてしまう。
 * 盤面が小さいほどそうなりやすい (2 次元 3 マスだと約 9 割) ため、
 * 遠回りが必要な問題が出るまでシードを送る。シード文字列から決定論的に
 * 導くので、同じ入力なら必ず同じ問題になる。
 *
 * 2 次元 2 マスだけは例外で、4 つの状態が輪になっているだけなので
 * どう作っても直線距離 (2 手) で解ける。そのまま返す。
 */
export function makeCoordPuzzle({ rank, width, seedText, maxAttempts = 80 }) {
  const dims = Array(rank).fill(width);
  const manhattan = rank * (width - 1);
  let fallback = null;

  const big = statesOf(rank, width) > EXPLICIT_MAX;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const seed = hashSeed(`${seedText}/${rank}x${width}#${attempt}`);
    // ループを作ると最短手数が直線距離まで落ちてパズルにならないので、どちらも輪なし
    const maze = big
      ? new HierMaze({ dims, seed, ...HIER_OPTIONS })
      : new MazeND({ dims, seed, braid: 0 });
    // 大きい盤面は全体を幅優先で探せないので、道筋を引いた区画から数える
    const par = big ? maze.solutionLength() : maze.path(maze.start, maze.goal).length - 1;
    const result = { maze, par, manhattan, detour: par - manhattan, attempts: attempt + 1 };
    if (!fallback) fallback = result;
    if (par > manhattan) return result;
  }
  return fallback;
}
