// diff-faster: a fast drop-in for makefun-diff 1.0.0.
//
// run(input) returns exactly makefun-diff 1.0.0's patch of { old, new }, as one
// string. The patch rule, restated from the competition (the house baseline's
// index.js states the same rule in its header):
//
//   Lines: a text is cut after every "\n" (the only separator; "\r" is part of
//   its line), and a last line with no "\n" is a line too. Two lines are equal
//   only when they are the same code units, newline or its absence included.
//   The edit script: the common prefix of lines is kept, then the common
//   suffix of the lines left; between them, Myers's greedy search from the
//   first lines, which keeps on each diagonal the path reaching furthest into
//   the old text and, when a deletion and an insertion reach the same point,
//   the deletion's, never moves past either text's end, prunes no edge
//   diagonal, and follows every run of lines equal in both as far as it goes;
//   the first path to reach both ends is the script.
//   The patch: a line "makefun-diff/1 old=N new=M hunks=H deleted=D
//   inserted=I", then each hunk's line "@ os ol ns nl" and one line per line
//   it covers ("=" kept, "-" deleted, "+" inserted); each run of changes lists
//   its deletions before its insertions and shows up to 3 kept lines before
//   and after it, and two runs at most 6 kept lines apart share a hunk. A line
//   that ends its text with no newline is written with one and followed by a
//   "%" line. Identical texts are the first line alone.
//
// This module is an original implementation of that rule. It is not a copy of
// the reference program: the search below is a purpose-built Myers over
// integer line ids with typed-array V rows, and the patch is formatted by
// direct string building. Nothing here is copied from makefun-diff's code.
//
// Speed notes. The reference walks the same search with a heap object per
// path per (d, k) step, which is what makes it slow. Here every line is
// hashed once to a small integer id, the search keeps one Int32Array per edit
// level d (the furthest x reached on each diagonal, stored as x + 1 so that 0
// means unreachable), and the script is rebuilt by walking those rows back
// down from the end, recomputing each step's pre-snake position from the rows
// rather than by re-comparing lines (re-comparing would mis-split the kept
// runs whenever a deleted or inserted line equals the line just kept before
// it, which the many repeated lines here make common). Before the search, an
// upper bound on the edit count is built from the lines that occur exactly
// once in each text (anchors, matched in order by longest increasing
// subsequence, with every gap between anchors diffed exactly); a diagonal
// that would still need more edits than that bound allows is not computed,
// which roughly halves the search, and the bound is a valid script's cost so
// the minimal script is never pruned.

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** Run kinds, as small integers so the search and the formatter stay cheap. */
const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/**
 * Split a text into its lines' contents, without the "\n" each line but the
 * last may carry. Returns { parts, n, bare }: parts[i] is line i's content,
 * n is the line count, and bare is true when the last line ends the text with
 * no newline. The empty text has no lines; "\n" has one, an empty line.
 */
function splitLines(text) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const n = last + (parts[last] !== '' ? 1 : 0);
  const bare = parts[last] !== '';
  return { parts, n, bare };
}

/**
 * Hash every line of both texts to a small integer id, one id per distinct
 * line, so the search compares integers instead of strings. A line that ends
 * its text with no newline must never share an id with a line that ends with
 * one, even when their contents match, so terminated lines and bare lines
 * draw from one counter through two maps. The id arrays are Int32Arrays over
 * the texts' lines, in order.
 */
function lineIds(oldText, newText) {
  const o = splitLines(oldText);
  const n = splitLines(newText);
  const idOf = new Map(); // terminated line content -> id
  const bareOf = new Map(); // bare line content -> id
  let next = 0;
  const ai = new Int32Array(o.n);
  const bi = new Int32Array(n.n);
  for (let i = 0; i < o.n; i++) {
    const s = o.parts[i];
    if (i === o.n - 1 && o.bare) {
      let id = bareOf.get(s);
      if (id === undefined) { id = next++; bareOf.set(s, id); }
      ai[i] = id;
    } else {
      let id = idOf.get(s);
      if (id === undefined) { id = next++; idOf.set(s, id); }
      ai[i] = id;
    }
  }
  for (let i = 0; i < n.n; i++) {
    const s = n.parts[i];
    if (i === n.n - 1 && n.bare) {
      let id = bareOf.get(s);
      if (id === undefined) { id = next++; bareOf.set(s, id); }
      bi[i] = id;
    } else {
      let id = idOf.get(s);
      if (id === undefined) { id = next++; idOf.set(s, id); }
      bi[i] = id;
    }
  }
  return { o, n, ai, bi, numIds: next };
}

/**
 * Myers's greedy search over the middle slices ai[0..N) and bi[0..M), the
 * lines left after the common prefix and suffix. Returns the edit script as
 * an array of [kind, count] runs, in order, kinds KEEP / DELETE / INSERT.
 *
 * The V history lives in one flat Int32Array: row d starts at d * d and
 * holds 2d + 1 entries, at index k + d, each the furthest x (old lines
 * consumed) any path of d edits reaches on diagonal k = x - y after
 * following its run of equal lines, stored as x + 1 so that 0 means no path
 * of d edits reaches that diagonal. One big allocation, sized by the upper
 * bound U on the edit count, replaces an allocation per level (a level's row
 * is mostly zeros, and allocating thousands of small typed arrays was the
 * search's largest cost after the loop itself). A step from level d - 1 takes
 * the deletion's x (one old line past the furthest point on k - 1) when that
 * reaches at least as far into the old text as the insertion's x (the
 * furthest point on k + 1), else the insertion's; a candidate is no
 * candidate when its line would fall past the end of its text, or its
 * diagonal was unreachable. The first (d, k), k rising, whose snake reaches
 * both ends is the script.
 *
 * U is an upper bound on the edit count (see upperBound). A path on diagonal
 * k at level d still needs at least |k - (N - M)| more edits to finish, one
 * per unit its diagonal must move, so a diagonal with
 * d + |k - (N - M)| > U cannot lie on a minimal script and is not computed.
 * The minimal script itself satisfies the bound at every level, so the
 * search, its first finishing diagonal and the rebuilt script are exactly
 * the unpruned search's.
 */
// The search history, reused across calls. A fresh (U+1)^2 Int32Array per
// case faults ~14k pages (~20 ms); this buffer is zeroed before each search
// and holds no answer data from one case to the next. (The search reads an
// entry only after writing it in the same search, or after the zeroing, so
// reusing the buffer cannot change a result.)
let _hist = null;
function historyFor(U) {
  let cap = U + 1;
  if (cap * cap > 67108864) cap = 4097; // absurd U: start small, grow
  const need = cap * cap;
  if (!_hist || _hist.length < need) _hist = new Int32Array(need);
  _hist.fill(0, 0, need);
  return _hist;
}

function myersRuns(ai, bi, N, M, U) {
  const kFinal = N - M;
  // One flat history, sized by U (the search ends by d = U at the latest).
  let capD = U + 1;
  if (capD * capD > 67108864) capD = 4097; // absurd U: start small, grow
  let V = historyFor(U);
  // d = 0: the snake from (0, 0).
  let x = 0;
  const lim0 = N < M ? N : M;
  while (x < lim0 && ai[x] === bi[x]) x++;
  V[0] = x + 1;
  if (x === N && x === M) return [];

  for (let d = 1; ; d++) {
    if (d >= capD) { // U understated the count: grow the history and go on
      let ncap = capD * 2;
      while (d >= ncap) ncap *= 2;
      const nv = new Int32Array(ncap * ncap);
      nv.set(V.subarray(0, capD * capD)); // the history is only capD^2 used
      _hist = nv;
      V = nv;
      capD = ncap;
    }
    const baseCur = d * d;
    const basePrev = (d - 1) * (d - 1);
    // The diagonals this level may use: d + |k - kFinal| <= U, within
    // [-d, d], with k the parity of d. (Empty only if U understates the
    // count, which a valid upper bound never does; the full range is then
    // used so the search still terminates.)
    const span = U - d;
    let kLo = kFinal - span;
    if (kLo < -d) kLo = -d;
    let kHi = kFinal + span;
    if (kHi > d) kHi = d;
    if (((kLo + d) & 1) !== 0) kLo++;
    if (((kHi + d) & 1) !== 0) kHi--;
    if (kLo > kHi) {
      kLo = -d;
      kHi = d;
    }
    // doneK is a diagonal, and -1 is a diagonal too, so "not done" needs
    // its own flag rather than a sentinel value.
    let doneK = 0;
    let found = false;

    // k = -d: insertion only, from diagonal -(d - 1), prev index 0.
    if (kLo === -d) {
      const w = V[basePrev];
      // Insertion is a candidate only while a new line is left to insert:
      // its y before the step, w + d - 2, must be below M.
      if (w !== 0 && w + d - 2 < M) {
        let xs = w - 1;
        let ys = xs + d;
        const lim = N < M + d ? N : M + d;
        while (xs < lim && ai[xs] === bi[ys]) { xs++; ys++; }
        V[baseCur] = xs + 1;
        if (xs === N && ys === M) { doneK = -d; found = true; }
      }
    }

    // Interior diagonals: both candidates live in prev, indices in range.
    const kStart = kLo < -d + 2 ? -d + 2 : kLo;
    const kEnd = kHi > d - 2 ? d - 2 : kHi;
    for (let k = kStart, iDel = kStart + d - 2, iIns = kStart + d, iCur = kStart + d;
         k <= kEnd; k += 2, iDel += 2, iIns += 2, iCur += 2) {
      const wd = V[basePrev + iDel]; // diagonal k - 1, stored as x + 1
      const wi = V[basePrev + iIns]; // diagonal k + 1, stored as x + 1
      const byDel = wd !== 0 && wd - 1 < N ? wd : -1;
      const byIns = wi !== 0 && wi - k - 2 < M ? wi - 1 : -1;
      let xs = byDel >= byIns ? byDel : byIns;
      if (xs < 0) continue;
      let ys = xs - k;
      const lim = N < M + k ? N : M + k;
      while (xs < lim && ai[xs] === bi[ys]) { xs++; ys++; }
      V[baseCur + iCur] = xs + 1;
      if (xs === N && ys === M) {
        doneK = k;
        found = true;
        break;
      }
    }

    // k = d: deletion only, from diagonal d - 1, prev index 2d - 2.
    if (!found && kHi === d) {
      const w = V[basePrev + 2 * d - 2];
      if (w !== 0 && w - 1 < N) {
        let xs = w; // one old line past the furthest point on k - 1
        let ys = xs - d;
        const lim = N < M + d ? N : M + d;
        while (xs < lim && ai[xs] === bi[ys]) { xs++; ys++; }
        V[baseCur + 2 * d] = xs + 1;
        if (xs === N && ys === M) { doneK = d; found = true; }
      }
    }

    if (found) return backtrack(V, ai, bi, N, M, d);
  }
}

/**
 * Rebuild the script from the V rows, walking down from the end. At level d
 * the current position (x, y) is the end of that level's snake; the step
 * before it is recomputed from the level d - 1 row exactly as the forward
 * search chose it, which gives the step's pre-snake position, and the kept
 * lines of that level's snake are the gap between the two. Recomputing the
 * pre-snake position matters: backing up by re-comparing lines would run
 * past the step whenever the deleted or inserted line equals the line kept
 * just before it.
 */
function backtrack(V, ai, bi, N, M, D) {
  const rev = []; // [kind, count], in reverse order
  let x = N;
  let y = M;
  let d = D;
  while (d > 0) {
    const k = x - y;
    const base = (d - 1) * (d - 1);
    const off = d - 1;
    const iDel = k - 1 + off;
    const iIns = k + 1 + off;
    const wd = iDel >= 0 && iDel < 2 * d - 1 ? V[base + iDel] : 0;
    const wi = iIns >= 0 && iIns < 2 * d - 1 ? V[base + iIns] : 0;
    const byDel = wd !== 0 && wd - 1 < N ? wd : -1;
    const byIns = wi !== 0 && wi - k - 2 < M ? wi - 1 : -1;
    let xPre;
    let isDel;
    if (byDel >= byIns) {
      isDel = true;
      xPre = byDel;
    } else {
      isDel = false;
      xPre = byIns;
    }
    const yPre = xPre - k;
    const keep = x - xPre;
    if (keep > 0) rev.push([KEEP, keep]);
    if (isDel) {
      rev.push([DELETE, 1]);
      x = xPre - 1;
      y = yPre;
    } else {
      rev.push([INSERT, 1]);
      x = xPre;
      y = yPre - 1;
    }
    d--;
  }
  // d = 0: the snake from (0, 0) to (x, x).
  if (x > 0) rev.push([KEEP, x]);

  // Reverse, merging runs of one kind that touch (a zero-length snake leaves
  // two edits of one kind side by side).
  const runs = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const r = rev[i];
    const last = runs.length > 0 ? runs[runs.length - 1] : undefined;
    if (last !== undefined && last[0] === r[0]) last[1] += r[1];
    else runs.push([r[0], r[1]]);
  }
  return runs;
}

/**
 * The minimal edit count alone, with the same search and the same tie-break
 * as myersRuns but keeping only two V rows and no history, so it is cheap
 * enough to call on many small gaps. Returns d, the number of edits.
 */
function myersCost(ai, bi, N, M) {
  let x = 0;
  const lim0 = N < M ? N : M;
  while (x < lim0 && ai[x] === bi[x]) x++;
  if (x === N && x === M) return 0;
  let prev = new Int32Array(1);
  prev[0] = x;
  for (let d = 1; ; d++) {
    const cur = new Int32Array(2 * d + 1);
    {
      const xp1 = prev[0];
      if (xp1 >= 0 && xp1 + d - 1 < M) {
        let xs = xp1;
        let ys = xs + d;
        const lim = N < M + d ? N : M + d;
        while (xs < lim && ai[xs] === bi[ys]) { xs++; ys++; }
        cur[0] = xs;
        if (xs === N && ys === M) return d;
      } else cur[0] = -1;
    }
    for (let k = -d + 2; k <= d - 2; k += 2) {
      const xm1 = prev[k + d - 2];
      const xp1 = prev[k + d];
      const byDel = xm1 >= 0 && xm1 < N ? xm1 + 1 : -1;
      const byIns = xp1 >= 0 && xp1 - k - 1 < M ? xp1 : -1;
      let xs = byDel >= byIns ? byDel : byIns;
      if (xs < 0) {
        cur[k + d] = -1;
        continue;
      }
      let ys = xs - k;
      const lim = N < M + k ? N : M + k;
      while (xs < lim && ai[xs] === bi[ys]) { xs++; ys++; }
      cur[k + d] = xs;
      if (xs === N && ys === M) return d;
    }
    {
      const xm1 = prev[prev.length - 1];
      if (xm1 >= 0 && xm1 < N) {
        let xs = xm1 + 1;
        let ys = xs - d;
        const lim = N < M + d ? N : M + d;
        while (xs < lim && ai[xs] === bi[ys]) { xs++; ys++; }
        cur[2 * d] = xs;
        if (xs === N && ys === M) return d;
      } else cur[2 * d] = -1;
    }
    prev = cur;
  }
}

/**
 * An upper bound on the minimal edit count of ai[0..N) into bi[0..M): the
 * cost of one valid edit script, built from anchors. A line id that occurs
 * exactly once in each text is an anchor; the anchors matched in order (the
 * longest increasing subsequence of their new positions, in old order) are
 * kept for free, and every gap between two matched anchors is diffed exactly
 * with myersCost. The sum is a valid script's cost, so it is never below the
 * minimal count, and with these texts it sits close above it: the anchors
 * are dense (most lines are distinct), so the gaps are small.
 *
 * numIds bounds the ids, so the counts and positions fit in flat arrays.
 */
function upperBound(ai, bi, N, M, numIds) {
  const cntO = new Int32Array(numIds);
  const cntN = new Int32Array(numIds);
  for (let i = 0; i < N; i++) cntO[ai[i]]++;
  for (let j = 0; j < M; j++) cntN[bi[j]]++;
  // The new position of each anchor id, -1 when it is not an anchor.
  const posN = new Int32Array(numIds);
  posN.fill(-1);
  for (let j = 0; j < M; j++) {
    const id = bi[j];
    if (cntO[id] === 1 && cntN[id] === 1) posN[id] = j;
  }
  // The anchors' (x, y) pairs, in old order: xs increasing, ys the sequence
  // the longest increasing subsequence runs over.
  const xs = [];
  const ys = [];
  for (let i = 0; i < N; i++) {
    const id = ai[i];
    if (cntO[id] === 1 && cntN[id] === 1) {
      xs.push(i);
      ys.push(posN[id]);
    }
  }
  const A = xs.length;
  if (A === 0) return myersCost(ai, bi, N, M);
  // Patience LIS over ys, strictly increasing, with parent pointers so the
  // matched anchors can be walked back out.
  const parent = new Int32Array(A);
  const tails = [];
  for (let i = 0; i < A; i++) {
    const y = ys[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ys[tails[mid]] < y) lo = mid + 1;
      else hi = mid;
    }
    parent[i] = lo > 0 ? tails[lo - 1] : -1;
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  // The matched anchors, in order, as a stack of indices into xs / ys.
  const matched = [];
  for (let i = tails[tails.length - 1]; i !== -1; i = parent[i]) matched.push(i);
  matched.reverse();
  // Every gap between two matched anchors, plus the two ends, diffed exactly.
  let cost = 0;
  let px = -1;
  let py = -1;
  for (let t = 0; t <= matched.length; t++) {
    const mi = t < matched.length ? matched[t] : -1;
    const nx = mi === -1 ? N : xs[mi];
    const ny = mi === -1 ? M : ys[mi];
    const gx = nx - px - 1;
    const gy = ny - py - 1;
    if (gx > 0 || gy > 0) {
      cost += myersCost(ai.subarray(px + 1, nx), bi.subarray(py + 1, ny), gx, gy);
    }
    px = nx;
    py = ny;
  }
  return cost;
}

/** A line as the patch writes it: its op, the line's content, a newline, and "%" on a line of its own when it had none. */
function written(op, content, bare) {
  return bare ? `${op}${content}\n%\n` : `${op}${content}\n`;
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const { o, n, ai, bi, numIds } = lineIds(input.old, input.new);
  const N = o.n;
  const M = n.n;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < N && prefix < M && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < N - prefix && suffix < M - prefix && ai[N - 1 - suffix] === bi[M - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  const midN = N - prefix - suffix;
  const midM = M - prefix - suffix;
  if (midN > 0 || midM > 0) {
    const aiMid = ai.subarray(prefix, N - suffix);
    const biMid = bi.subarray(prefix, M - suffix);
    const U = upperBound(aiMid, biMid, midN, midM, numIds);
    runs.push(...myersRuns(aiMid, biMid, midN, midM, U));
  }
  if (suffix > 0) runs.push([KEEP, suffix]);

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let atO = 0;
  let atP = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r[0] === KEEP) {
      atO += r[1];
      atP += r[1];
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== atO || c.p + c.ins !== atP) {
      c = { o: atO, p: atP, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r[0] === DELETE) {
      c.dels += r[1];
      atO += r[1];
      deleted += r[1];
    } else {
      c.ins += r[1];
      atP += r[1];
      inserted += r[1];
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${N} new=${M} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  const oldParts = o.parts;
  const newParts = n.parts;
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, N - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', oldParts[at], at === N - 1 && o.bare));
      for (let i = 0; i < c.dels; i++) out.push(written('-', oldParts[c.o + i], c.o + i === N - 1 && o.bare));
      for (let i = 0; i < c.ins; i++) out.push(written('+', newParts[c.p + i], c.p + i === M - 1 && n.bare));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', oldParts[at], at === N - 1 && o.bare));
  }
  return out.join('');
}
