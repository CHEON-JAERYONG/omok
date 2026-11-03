/* 오목 규칙 — 브라우저(window.OmokRules)와 Node(module.exports) 양쪽에서 사용 */
(function (root) {
  'use strict';
  var N = 15;
  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  function inb(x, y) { return x >= 0 && y >= 0 && x < N && y < N; }
  function get(b, x, y) { return inb(x, y) ? b[y * N + x] : -1; } // -1 벽, 0 빈칸, 1 흑, 2 백

  function makeBoard(moves) {
    var b = new Int8Array(N * N);
    for (var i = 0; i < moves.length; i++) b[moves[i][1] * N + moves[i][0]] = (i % 2 === 0) ? 1 : 2;
    return b;
  }

  // (x,y)에 c 돌이 있다고 가정하고, 방향 (dx,dy)로 이어진 길이
  function span(b, x, y, dx, dy, c) {
    var s = 0, e = 0;
    while (get(b, x - dx * (s + 1), y - dy * (s + 1)) === c) s++;
    while (get(b, x + dx * (e + 1), y + dy * (e + 1)) === c) e++;
    return { s: s, e: e, len: s + e + 1 };
  }

  // 승리 줄 찾기. exact=true면 정확히 5개만 인정(6목 무효)
  function fiveLine(b, x, y, c, exact) {
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var r = span(b, x, y, dx, dy, c);
      if (exact ? r.len === 5 : r.len >= 5) {
        var cells = [];
        for (var i = -r.s; i <= r.e; i++) cells.push([x + dx * i, y + dy * i]);
        return cells;
      }
    }
    return null;
  }

  // 열린 4: 정확히 4개가 이어지고 양 끝이 비어 있음(양쪽 어디를 둬도 5목)
  function isOpenFourDir(b, x, y, dx, dy, c, exact) {
    var r = span(b, x, y, dx, dy, c);
    if (r.len !== 4) return false;
    var ax = x - dx * (r.s + 1), ay = y - dy * (r.s + 1);
    var bx = x + dx * (r.e + 1), by = y + dy * (r.e + 1);
    if (get(b, ax, ay) !== 0 || get(b, bx, by) !== 0) return false;
    if (exact && (get(b, ax - dx, ay - dy) === c || get(b, bx + dx, by + dy) === c)) return false;
    return true;
  }

  // 열린 3: 한 수 더 두면 (x,y)를 포함한 열린 4가 되는 줄
  function isOpenThreeDir(b, x, y, dx, dy, c, exact) {
    for (var i = -4; i <= 4; i++) {
      if (i === 0) continue;
      var px = x + dx * i, py = y + dy * i;
      if (get(b, px, py) !== 0) continue;
      b[py * N + px] = c;
      var ok = false;
      var r = span(b, px, py, dx, dy, c);
      if (-i >= -r.s && -i <= r.e) ok = isOpenFourDir(b, px, py, dx, dy, c, exact);
      b[py * N + px] = 0;
      if (ok) return true;
    }
    return false;
  }

  function isDoubleThree(b, x, y, c, exact) {
    var n = 0;
    for (var d = 0; d < 4; d++) {
      if (isOpenThreeDir(b, x, y, DIRS[d][0], DIRS[d][1], c, exact)) n++;
      if (n >= 2) return true;
    }
    return false;
  }

  /**
   * 착수 검사
   * rule: 'normal' = 3-3 금지(흑·백 모두) + 6목 이상 무효 / 'free' = 금수 없음, 5목 이상 승리
   * 반환: { ok, reason?, win?: [[x,y]...], draw? }
   */
  function checkMove(moves, x, y, rule) {
    if (!inb(x, y)) return { ok: false, reason: 'out' };
    var b = makeBoard(moves);
    if (b[y * N + x] !== 0) return { ok: false, reason: 'occupied' };
    var c = moves.length % 2 === 0 ? 1 : 2;
    var exact = rule === 'normal';
    b[y * N + x] = c;
    var line = fiveLine(b, x, y, c, exact);
    if (line) return { ok: true, win: line };
    if (rule === 'normal' && isDoubleThree(b, x, y, c, exact)) return { ok: false, reason: '33' };
    if (moves.length + 1 >= N * N) return { ok: true, draw: true };
    return { ok: true };
  }

  // 지금 둘 차례인 돌의 금수 자리 목록
  function forbiddenCells(moves, rule) {
    var out = [];
    if (rule !== 'normal') return out;
    var b = makeBoard(moves);
    var c = moves.length % 2 === 0 ? 1 : 2;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var i = y * N + x;
        if (b[i] !== 0) continue;
        b[i] = c;
        if (!fiveLine(b, x, y, c, true) && isDoubleThree(b, x, y, c, true)) out.push([x, y]);
        b[i] = 0;
      }
    }
    return out;
  }

  var api = { N: N, makeBoard: makeBoard, checkMove: checkMove, forbiddenCells: forbiddenCells };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OmokRules = api;
})(this);
