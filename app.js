/* 온라인 오목 — 공개 MQTT 중계 서버 2곳(동시 접속)으로 두 사람의 판을 맞춥니다. 가입·키 불필요. */
(function () {
  'use strict';

  var N = OmokRules.N;
  var TOPIC_ROOT = 'cjr-omok/v1/';
  var BROKERS = [
    { url: 'wss://broker.emqx.io:8084/mqtt' },
    { url: 'wss://public.cloud.shiftr.io', username: 'public', password: 'public' } // 443 포트 — 회사망 등에서도 통과
  ];
  var ONLINE_MS = 25000, BEAT_MS = 8000;
  var RULE_HELP = {
    normal: '3·3 금지(흑·백 모두), 6목 이상은 승리 아님',
    free: '금수 없음 — 5목 이상 이으면 승리'
  };

  function $(id) { return document.getElementById(id); }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { } }
  };
  function rid(n) {
    var a = 'abcdefghjkmnpqrstuvwxyz23456789', s = '', r = crypto.getRandomValues(new Uint8Array(n));
    for (var i = 0; i < n; i++) s += a[r[i] % a.length];
    return s;
  }
  function cleanCode(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12); }
  function other(c) { return c === 'B' ? 'W' : 'B'; }
  function colorName(c) { return c === 'B' ? '⚫ 흑' : '⚪ 백'; }

  var params = new URLSearchParams(location.search);
  var myId = cleanCode(params.get('me')) || store.get('omok.id', '');
  if (!myId) { myId = rid(12); store.set('omok.id', myId); }
  var myName = store.get('omok.name', '');
  var prefs = {
    sound: store.get('omok.sound', '1') === '1',
    num: store.get('omok.num', '0') === '1',
    confirm: store.get('omok.confirm', '1') === '1'
  };
  function setName(n) { myName = n.trim().slice(0, 12); store.set('omok.name', myName); }

  /* ================= 토스트 · 소리 ================= */
  var toastTimer = 0;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; t.hidden = false;
    t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, ms || 2300);
  }

  var actx = null;
  function unlockAudio() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { } }
    if (actx && actx.state === 'suspended') actx.resume();
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  function sound(kind) {
    if (!prefs.sound || !actx || actx.state !== 'running') return;
    var t = actx.currentTime;
    if (kind === 'stone') {
      var len = Math.floor(actx.sampleRate * 0.05), buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 4);
      var src = actx.createBufferSource(); src.buffer = buf;
      var bp = actx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1700; bp.Q.value = 1.1;
      var g = actx.createGain(); g.gain.value = 0.9;
      src.connect(bp); bp.connect(g); g.connect(actx.destination); src.start(t);
      var o = actx.createOscillator(); o.frequency.setValueAtTime(380, t); o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
      var g2 = actx.createGain(); g2.gain.setValueAtTime(0.28, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      o.connect(g2); g2.connect(actx.destination); o.start(t); o.stop(t + 0.12);
      return;
    }
    var notes = kind === 'win' ? [523, 659, 784, 1046] : kind === 'lose' ? [392, 330, 262] : [880, 1175];
    notes.forEach(function (f, i) {
      var o = actx.createOscillator(); o.type = 'triangle'; o.frequency.value = f;
      var g = actx.createGain(), st = t + i * 0.12;
      g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(0.16, st + 0.02); g.gain.exponentialRampToValueAtTime(0.001, st + 0.35);
      o.connect(g); g.connect(actx.destination); o.start(st); o.stop(st + 0.4);
    });
  }

  /* ================= 로비 ================= */
  function segInit(id, onChange) {
    var el = $(id);
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      el.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); });
      if (onChange) onChange(b.dataset.v);
    });
  }
  function segVal(id) { var b = $(id).querySelector('button.on'); return b ? b.dataset.v : null; }

  function showLobby() {
    $('lobby').hidden = false;
    $('lobbyName').value = myName;
    segInit('ruleSeg', function (v) { $('ruleHelp').textContent = RULE_HELP[v]; });
    segInit('colorSeg');
    $('createBtn').onclick = function () {
      var name = $('lobbyName').value.trim();
      if (!name) { toast('이름을 적어 주세요'); $('lobbyName').focus(); return; }
      setName(name);
      var c = segVal('colorSeg'); if (c === 'R') c = Math.random() < 0.5 ? 'B' : 'W';
      var code = rid(6);
      var st = {
        v: 1, room: code, seq: 1, by: myId, ts: Date.now(),
        rule: segVal('ruleSeg'),
        players: { host: { id: myId, name: myName }, guest: null },
        hostColor: c, moves: [], status: 'waiting', result: null, undo: null,
        game: 1, score: { host: 0, guest: 0 }
      };
      history.pushState(null, '', '?r=' + code);
      $('lobby').hidden = true;
      enterRoom(code, st);
    };
    function join() {
      var code = cleanCode($('joinCode').value);
      if (code.length < 4) { toast('방 코드를 확인해 주세요'); return; }
      var name = $('lobbyName').value.trim(); if (name) setName(name);
      location.href = '?r=' + code;
    }
    $('joinBtn').onclick = join;
    $('joinCode').addEventListener('keydown', function (e) { if (e.key === 'Enter') join(); });
  }

  /* ================= 대국실 상태 ================= */
  var room = '', base = '', cur = null, clients = [];
  var peers = {};            // id -> {name, last, off}
  var seenBest = [], lastHeal = [], everConnected = false;
  var chatSeen = {};
  var joinedAt = Date.now(), seatTried = false;
  var ui = { hover: null, pending: null, anim: null, resultHidden: false, forb: [], forbKey: '' };

  function newer(a, b) { return a.seq > b.seq || (a.seq === b.seq && String(a.by) > String(b.by)); }
  function myRole() {
    if (!cur) return null;
    if (cur.players.host && cur.players.host.id === myId) return 'host';
    if (cur.players.guest && cur.players.guest.id === myId) return 'guest';
    return null;
  }
  function isMember() { return !!myRole(); }
  function roleOfColor(c) { return cur.hostColor === c ? 'host' : 'guest'; }
  function colorOfRole(r) { return r === 'host' ? cur.hostColor : other(cur.hostColor); }
  function myColor() { var r = myRole(); return r ? colorOfRole(r) : null; }
  function playerOf(c) { return cur.players[roleOfColor(c)]; }
  function turnColor() { return cur.moves.length % 2 === 0 ? 'B' : 'W'; }
  function canMove() { return !!cur && cur.status === 'playing' && myColor() === turnColor(); }
  function occupied(c) { return cur.moves.some(function (m) { return m[0] === c[0] && m[1] === c[1]; }); }
  function isOnline(id) {
    if (id === myId) return clients.some(function (c) { return c && c.connected; });
    var p = peers[id];
    return !!p && !p.off && Date.now() - p.last < ONLINE_MS;
  }

  function validState(s) {
    try {
      if (s.v !== 1 || s.room !== room || typeof s.seq !== 'number' || !Array.isArray(s.moves) || s.moves.length > N * N) return false;
      if (!s.players || !s.players.host || typeof s.players.host.id !== 'string') return false;
      if (s.hostColor !== 'B' && s.hostColor !== 'W') return false;
      var seen = {};
      for (var i = 0; i < s.moves.length; i++) {
        var m = s.moves[i];
        if (!Array.isArray(m) || !(m[0] >= 0 && m[0] < N && m[1] >= 0 && m[1] < N) || m[0] % 1 || m[1] % 1) return false;
        var k = m[1] * N + m[0]; if (seen[k]) return false; seen[k] = 1;
      }
      if (!s.score) s.score = { host: 0, guest: 0 };
      if (!s.game) s.game = 1;
      return true;
    } catch (e) { return false; }
  }

  function commit(fn) {
    if (!cur) return;
    var s = JSON.parse(JSON.stringify(cur));
    fn(s);
    s.seq = cur.seq + 1; s.by = myId; s.ts = Date.now();
    applyState(s, true);
    publishState(s);
  }

  function applyState(s, local) {
    var p = cur;
    cur = s;
    if (p) {
      var pm = p.moves.length, sm = s.moves.length;
      if (s.game !== p.game) {
        addSys(s.game + '번째 판 시작! ' + playerOf('B').name + '님이 흑이에요');
        ui.resultHidden = false; ui.pending = null;
        if (!local) sound('ping');
      } else if (sm > pm) {
        var last = s.moves[sm - 1];
        ui.anim = { x: last[0], y: last[1], t0: performance.now() };
        sound('stone');
        if (!local && canMove()) { if (navigator.vibrate) try { navigator.vibrate(40); } catch (e) { } }
      } else if (sm < pm) {
        addSys('무르기를 했어요');
        ui.pending = null;
      }
      if (!p.result && s.result) onResult(s);
      if (!p.players.guest && s.players.guest) {
        addSys(s.players.guest.name + '님이 들어왔어요');
        if (myRole() === 'host') { toast(s.players.guest.name + '님 입장! 대국을 시작해요'); sound('ping'); }
      }
      if (s.game === p.game && sm === pm && p.undo && !s.undo && !local && p.undo.by === myColor()) toast('상대가 무르기를 거절했어요');
      if (!p.undo && s.undo && myColor() && s.undo.by !== myColor()) { toast('상대가 무르기를 요청했어요'); sound('ping'); }
    }
    autoSeat();
    render();
  }

  function onResult(s) {
    ui.resultHidden = false;
    var mc = myColor();
    if (!mc || s.result.winner === 'D') sound('ping');
    else sound(s.result.winner === mc ? 'win' : 'lose');
  }

  function autoSeat() {
    if (!cur || !myName || seatTried || isMember()) return;
    if (!cur.players.guest && cur.players.host.id !== myId) {
      seatTried = true;
      commit(function (s) {
        s.players.guest = { id: myId, name: myName };
        if (s.status === 'waiting') s.status = 'playing';
      });
    }
  }

  /* ================= 네트워크 (MQTT 2곳 동시) ================= */
  function connectNet() {
    clients = BROKERS.map(function (b, i) {
      var c;
      try {
        c = mqtt.connect(b.url, {
          clientId: 'omok_' + myId + '_' + rid(5),
          username: b.username, password: b.password,
          keepalive: 30, reconnectPeriod: 4000, connectTimeout: 12000,
          clean: true, resubscribe: false, queueQoSZero: false,
          will: { topic: base + 'p/' + myId, payload: JSON.stringify({ id: myId, off: 1 }), qos: 0, retain: false }
        });
      } catch (e) { console.warn('broker', i, e); return null; }
      c.on('connect', function () {
        everConnected = true;
        seenBest[i] = null;
        c.subscribe(base + '#', { qos: 1 }, function (err) { if (err) console.warn('sub', i, err); });
        setTimeout(function () { syncBroker(i); }, 1800);
        sendPresence(i);
        renderNet(); renderPlayers();
      });
      c.on('message', function (t, m, pk) { onMsg(i, t.slice(base.length), m, pk); });
      ['close', 'offline', 'reconnect', 'error'].forEach(function (ev) { c.on(ev, function (e) { if (ev === 'error') console.warn('mqtt', i, e && e.message); renderNet(); }); });
      return c;
    });
  }
  function pub(i, sub, obj, opts) {
    var c = clients[i];
    if (c && c.connected) c.publish(base + sub, JSON.stringify(obj), opts || { qos: 0 });
  }
  function pubAll(sub, obj, opts) { for (var i = 0; i < clients.length; i++) pub(i, sub, obj, opts); }
  function publishState(s, i) {
    var o = { qos: 1, retain: true };
    if (i == null) pubAll('state', s, o); else pub(i, 'state', s, o);
  }
  function syncBroker(i) { if (cur && (!seenBest[i] || newer(cur, seenBest[i]))) publishState(cur, i); }
  function heal(i) {
    if (Date.now() - (lastHeal[i] || 0) < 3000) return;
    lastHeal[i] = Date.now();
    publishState(cur, i);
  }

  function onMsg(i, sub, buf, pk) {
    var d;
    try { d = JSON.parse(buf.toString()); } catch (e) { return; }
    if (!d || typeof d !== 'object') return;
    if (sub === 'state') {
      if (!validState(d)) return;
      if (!seenBest[i] || newer(d, seenBest[i])) seenBest[i] = d;
      if (!cur || newer(d, cur)) applyState(d, false);
      else if (newer(cur, d) && pk && pk.retain) heal(i);
    } else if (sub.indexOf('p/') === 0) onPresence(i, d);
    else if (sub === 'c') onChat(d);
  }

  function sendPresence(i, reply) {
    var o = { id: myId, name: myName || '손님', t: Date.now() };
    if (reply) o.r = 1;
    if (i == null) pubAll('p/' + myId, o); else pub(i, 'p/' + myId, o);
  }
  function onPresence(i, d) {
    if (typeof d.id !== 'string' || d.id === myId) return;
    var wasOn = isOnline(d.id);
    if (d.off) {
      if (peers[d.id]) { peers[d.id].off = true; }
      renderPlayers();
      return;
    }
    peers[d.id] = { name: String(d.name || '').slice(0, 12), last: Date.now(), off: false };
    if (!wasOn) {
      if (!d.r) {
        sendPresence(i, true);
        if (cur && isMember()) publishState(cur, i);
      }
      renderPlayers();
    }
  }

  /* ================= 채팅 ================= */
  function onChat(d) {
    if (typeof d.mid !== 'string' || typeof d.text !== 'string' || chatSeen[d.mid]) return;
    chatSeen[d.mid] = 1;
    addMsg(d);
    if (d.id !== myId) {
      sound('ping');
      if (!chatVisible()) toast(String(d.name || '').slice(0, 12) + ': ' + d.text.slice(0, 120), 3200);
    }
  }
  function chatVisible() {
    var r = $('msgs').getBoundingClientRect();
    return r.top < innerHeight && r.bottom > 0 && !document.hidden;
  }
  function sendChat(text) {
    text = String(text).trim().slice(0, 120);
    if (!text) return;
    var d = { mid: rid(10), id: myId, name: myName || '손님', text: text, t: Date.now() };
    chatSeen[d.mid] = 1;
    addMsg(d);
    pubAll('c', d, { qos: 1 });
  }
  function addMsg(d) {
    var ol = $('msgs'), empty = ol.querySelector('.empty');
    if (empty) empty.remove();
    var li = document.createElement('li');
    if (d.id === myId) li.className = 'mine';
    else { var b = document.createElement('b'); b.textContent = String(d.name || '손님').slice(0, 12); li.appendChild(b); }
    li.appendChild(document.createTextNode(d.text.slice(0, 120)));
    ol.appendChild(li);
    while (ol.children.length > 80) ol.firstChild.remove();
    ol.scrollTop = ol.scrollHeight;
  }
  function addSys(text) {
    var ol = $('msgs'), empty = ol.querySelector('.empty');
    if (empty) empty.remove();
    var li = document.createElement('li'); li.className = 'sys'; li.textContent = text;
    ol.appendChild(li); ol.scrollTop = ol.scrollHeight;
  }

  /* ================= 오목판 그리기 ================= */
  var cv, ctx, geo = {};
  function pt(i) { return geo.pad + i * geo.cell; }
  function resizeBoard() {
    var r = cv.getBoundingClientRect();
    if (!r.width) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.width * dpr);
    geo = { dpr: dpr, size: r.width, pad: r.width * 0.048 };
    geo.cell = (r.width - 2 * geo.pad) / (N - 1);
    draw();
  }

  function drawStone(x, y, c, alpha, scale) {
    var cx = pt(x), cy = pt(y), r = geo.cell * 0.465 * (scale || 1);
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.beginPath(); ctx.arc(cx + r * 0.07, cy + r * 0.12, r, 0, 7); ctx.fillStyle = 'rgba(40,20,0,.28)'; ctx.fill();
    var g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.08, cx, cy, r);
    if (c === 'B') { g.addColorStop(0, '#707070'); g.addColorStop(1, '#0b0b0b'); }
    else { g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#cfcdc4'); }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fillStyle = g; ctx.fill();
    if (c === 'W') { ctx.strokeStyle = 'rgba(0,0,0,.22)'; ctx.lineWidth = 0.8; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  function drawX(x, y, color, size) {
    var cx = pt(x), cy = pt(y), s = geo.cell * (size || 0.17);
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(1.5, geo.cell * 0.07); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - s, cy - s); ctx.lineTo(cx + s, cy + s); ctx.moveTo(cx + s, cy - s); ctx.lineTo(cx - s, cy + s); ctx.stroke();
  }

  function draw() {
    if (!geo.size) return;
    var size = geo.size, cell = geo.cell, i;
    ctx.setTransform(geo.dpr, 0, 0, geo.dpr, 0, 0);
    // 나무판
    var g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#ebc47f'); g.addColorStop(1, '#d4a058');
    ctx.fillStyle = g; ctx.fillRect(0, 0, size, size);
    ctx.globalAlpha = 0.07; ctx.strokeStyle = '#6b3d0c';
    for (i = 0; i < 22; i++) {
      var y0 = (i + 0.5) * size / 22 + Math.sin(i * 1.7) * 5;
      ctx.lineWidth = 1 + (i * 7) % 3;
      ctx.beginPath(); ctx.moveTo(0, y0);
      ctx.bezierCurveTo(size * 0.3, y0 + 7 * Math.sin(i), size * 0.7, y0 - 7 * Math.cos(i), size, y0 + 3);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // 줄
    ctx.strokeStyle = '#4a2e10'; ctx.lineWidth = Math.max(0.8, size / 700);
    ctx.beginPath();
    for (i = 0; i < N; i++) {
      ctx.moveTo(pt(0), pt(i)); ctx.lineTo(pt(N - 1), pt(i));
      ctx.moveTo(pt(i), pt(0)); ctx.lineTo(pt(i), pt(N - 1));
    }
    ctx.stroke();
    ctx.lineWidth = Math.max(1.5, size / 380);
    ctx.strokeRect(pt(0), pt(0), pt(N - 1) - pt(0), pt(N - 1) - pt(0));
    ctx.fillStyle = '#4a2e10';
    [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]].forEach(function (s) {
      ctx.beginPath(); ctx.arc(pt(s[0]), pt(s[1]), Math.max(2, cell * 0.1), 0, 7); ctx.fill();
    });
    if (!cur) return;

    // 금수 표시(일반 룰, 둘 차례인 사람·관전자에게만)
    if (cur.status === 'playing' && cur.rule === 'normal' && (myColor() === turnColor() || !isMember())) {
      ui.forb.forEach(function (f) { drawX(f[0], f[1], 'rgba(190,30,20,.55)', 0.14); });
    }

    // 돌
    var now = performance.now(), animating = false, n = cur.moves.length;
    cur.moves.forEach(function (m, k) {
      var sc = 1;
      if (ui.anim && k === n - 1 && ui.anim.x === m[0] && ui.anim.y === m[1]) {
        var p = (now - ui.anim.t0) / 170;
        if (p < 1) { sc = 1 + 0.22 * (1 - p) * (1 - p); animating = true; } else ui.anim = null;
      }
      drawStone(m[0], m[1], k % 2 === 0 ? 'B' : 'W', 1, sc);
    });
    if (prefs.num) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '700 ' + Math.round(cell * (n > 99 ? 0.36 : 0.44)) + 'px Pretendard, system-ui, sans-serif';
      cur.moves.forEach(function (m, k) {
        ctx.fillStyle = k === n - 1 ? '#e8402a' : (k % 2 === 0 ? '#fff' : '#222');
        ctx.fillText(String(k + 1), pt(m[0]), pt(m[1]) + cell * 0.03);
      });
    } else if (n) {
      var lm = cur.moves[n - 1];
      ctx.beginPath(); ctx.arc(pt(lm[0]), pt(lm[1]), cell * 0.13, 0, 7); ctx.fillStyle = '#e8402a'; ctx.fill();
    }

    // 승리 줄
    if (cur.result && cur.result.line && cur.result.line.length) {
      var L = cur.result.line, a = L[0], b = L[L.length - 1];
      ctx.strokeStyle = 'rgba(232,64,42,.85)'; ctx.lineWidth = cell * 0.12; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(pt(a[0]), pt(a[1])); ctx.lineTo(pt(b[0]), pt(b[1])); ctx.stroke();
      L.forEach(function (c) { ctx.beginPath(); ctx.arc(pt(c[0]), pt(c[1]), cell * 0.47, 0, 7); ctx.lineWidth = cell * 0.06; ctx.stroke(); });
    }

    // 미리보기 돌
    var gh = ui.pending || ui.hover;
    if (gh && canMove() && !occupied(gh)) {
      var forb = ui.forb.some(function (f) { return f[0] === gh[0] && f[1] === gh[1]; });
      if (forb) drawX(gh[0], gh[1], '#c0261b', 0.26);
      else {
        drawStone(gh[0], gh[1], myColor(), ui.pending ? 0.7 : 0.45);
        if (ui.pending) {
          ctx.strokeStyle = '#e8402a'; ctx.lineWidth = Math.max(1.5, cell * 0.06);
          ctx.beginPath(); ctx.arc(pt(gh[0]), pt(gh[1]), cell * 0.5, 0, 7); ctx.stroke();
        }
      }
    }
    if (animating) requestAnimationFrame(draw);
  }

  function cellAt(e) {
    var r = cv.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    var x = Math.round((px - geo.pad) / geo.cell), y = Math.round((py - geo.pad) / geo.cell);
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    if (Math.hypot(px - pt(x), py - pt(y)) > geo.cell * 0.62) return null;
    return [x, y];
  }
  function same(a, b) { return !!a && !!b && a[0] === b[0] && a[1] === b[1]; }

  function onCellTap(c, touch) {
    if (!cur) return;
    if (!canMove()) {
      if (cur.status === 'waiting') toast('친구가 들어오면 시작해요');
      else if (cur.status === 'playing' && isMember()) toast('상대 차례예요');
      else if (cur.status === 'playing') toast('관전 중이에요');
      return;
    }
    if (occupied(c)) return;
    if (touch && prefs.confirm) {
      if (ui.pending && same(ui.pending, c)) place(c);
      else {
        ui.pending = c;
        if (ui.forb.some(function (f) { return same(f, c); })) toast('3·3 금수 자리예요');
        draw(); renderPlaceBtn();
      }
      return;
    }
    place(c);
  }

  function place(c) {
    if (!canMove()) return;
    var r = OmokRules.checkMove(cur.moves, c[0], c[1], cur.rule);
    if (!r.ok) { toast(r.reason === '33' ? '3·3 금수 자리예요 (일반 룰)' : '둘 수 없는 자리예요'); return; }
    var color = turnColor(), role = myRole();
    ui.pending = null; ui.hover = null;
    commit(function (s) {
      s.moves.push([c[0], c[1]]);
      s.undo = null;
      if (r.win) { s.status = 'ended'; s.result = { winner: color, reason: 'five', line: r.win }; s.score[role] = (s.score[role] || 0) + 1; }
      else if (r.draw) { s.status = 'ended'; s.result = { winner: 'D', reason: 'full' }; }
    });
  }

  /* ================= 화면 갱신 ================= */
  function render() {
    if (!cur) { renderNet(); draw(); return; }
    var key = cur.game + ':' + cur.moves.length + ':' + cur.rule + ':' + cur.status;
    if (key !== ui.forbKey) { ui.forbKey = key; ui.forb = cur.status === 'playing' ? OmokRules.forbiddenCells(cur.moves, cur.rule) : []; }
    if (ui.pending && (!canMove() || occupied(ui.pending))) ui.pending = null;
    renderPlayers(); renderStatus(); renderActions(); renderPlaceBtn(); renderNet(); updateTitle();
    $('ruleText').textContent = (cur.rule === 'normal' ? '일반 룰 — ' : '자유 룰 — ') + RULE_HELP[cur.rule];
    if (!$('nameModal').hidden) renderNameModal();
    draw();
  }

  function renderPlayers() {
    var watchers = 0;
    Object.keys(peers).forEach(function (id) {
      if (!isOnline(id)) return;
      if (cur && ((cur.players.host && cur.players.host.id === id) || (cur.players.guest && cur.players.guest.id === id))) return;
      watchers++;
    });
    $('watchers').textContent = watchers ? '관전 ' + watchers + '명' : '';
    ['B', 'W'].forEach(function (c) {
      var el = $('p' + c), nm = el.querySelector('.nm'), st = el.querySelector('.pstat'), stt = el.querySelector('.st');
      var tk = el.querySelector('.take');
      if (!cur) { nm.textContent = '-'; stt.textContent = '-'; tk.hidden = true; return; }
      var role = roleOfColor(c), p = cur.players[role];
      nm.textContent = p ? p.name : '(빈 자리)';
      el.querySelector('.me-tag').hidden = !(p && p.id === myId);
      var on = false, label;
      if (!p) label = '기다리는 중';
      else if (p.id === myId) { on = isOnline(myId); label = on ? '접속 중' : '연결 중…'; }
      else if (isOnline(p.id)) { on = true; label = '접속 중'; }
      else if (peers[p.id] && peers[p.id].off) label = '나감';
      else if (Date.now() - joinedAt < 12000) label = '확인 중…';
      else label = '자리 비움';
      st.classList.toggle('on', on);
      stt.textContent = label;
      el.querySelector('.pscore').textContent = cur.score[role] || 0;
      el.classList.toggle('turn', cur.status === 'playing' && turnColor() === c);
      tk.hidden = !(!isMember() && myName && p && !on && Date.now() - joinedAt > 15000);
      tk.onclick = function () {
        if (isMember() || !cur.players[role] || isOnline(cur.players[role].id)) return;
        commit(function (s) { s.players[role] = { id: myId, name: myName }; });
        toast('자리를 이어받았어요');
      };
    });
  }

  function renderStatus() {
    var el = $('status'), text, mine = false, n = cur.moves.length;
    var mc = myColor();
    if (cur.status === 'waiting') text = isMember() ? '친구를 기다리는 중…' : '대국 준비 중';
    else if (cur.status === 'ended') {
      var r = cur.result || {};
      if (r.winner === 'D') text = '무승부 — 판이 가득 찼어요';
      else {
        var wp = playerOf(r.winner), wn = wp ? wp.name : colorName(r.winner);
        text = (mc ? (r.winner === mc ? '🎉 이겼어요! ' : '😢 졌어요. ') : '') + wn + '님(' + colorName(r.winner) + ') 승리' + (r.reason === 'resign' ? ' · 상대 기권' : '');
      }
    } else {
      var t = turnColor(), p = playerOf(t);
      if (mc === t) { text = '내 차례예요 (' + colorName(t) + ')'; mine = true; }
      else if (mc) text = (p ? p.name : '상대') + '님 차례 — 생각 중…';
      else text = '관전 중 · ' + (p ? p.name : '') + '님(' + colorName(t) + ') 차례';
      text += ' · ' + (n + 1) + '수째';
    }
    el.textContent = text;
    el.classList.toggle('mine', mine);

    // 초대 화면
    $('inviteOverlay').hidden = !(cur.status === 'waiting' && isMember());
    $('inviteLink').textContent = inviteUrl();

    // 결과 화면
    var showRes = cur.status === 'ended' && !ui.resultHidden;
    $('resultOverlay').hidden = !showRes;
    if (showRes) {
      var res = cur.result || {}, title, sub;
      if (res.winner === 'D') { title = '무승부'; sub = '판이 가득 찼어요'; }
      else {
        var w = playerOf(res.winner), l = playerOf(other(res.winner));
        title = mc ? (res.winner === mc ? '이겼어요! 🎉' : '졌어요 😢') : (w ? w.name : '') + '님 승리!';
        sub = res.reason === 'resign' ? (l ? l.name : '상대') + '님이 기권했어요'
          : (w ? w.name : '') + '님(' + colorName(res.winner) + ')이 5목을 완성했어요';
      }
      sub += '\n전적 ' +(cur.players.host ? cur.players.host.name : '') + ' ' + (cur.score.host || 0) + ' : ' + (cur.score.guest || 0) + ' ' + (cur.players.guest ? cur.players.guest.name : '');
      $('resultTitle').textContent = title;
      $('resultSub').textContent = sub;
      $('rematchBtn2').hidden = !isMember();
    }
  }

  function renderActions() {
    var mem = isMember(), playing = cur.status === 'playing', mc = myColor(), n = cur.moves.length;
    var confirming = !$('resignConfirm').hidden;
    $('undoBtn').hidden = !(mem && playing) || confirming;
    $('undoBtn').disabled = !(n > 0 && ((n - 1) % 2 === 0 ? 'B' : 'W') === mc && !cur.undo);
    $('resignBtn').hidden = !(mem && playing) || confirming;
    $('rematchBtn').hidden = !(mem && cur.status === 'ended');
    if (!(mem && playing)) $('resignConfirm').hidden = true;

    var bn = $('undoBanner');
    if (cur.undo && playing) {
      bn.hidden = false;
      var mineReq = cur.undo.by === mc, req = playerOf(cur.undo.by);
      $('undoText').textContent = mineReq ? '무르기 요청 중… 상대의 대답을 기다려요' : (req ? req.name : '상대') + '님이 무르기를 요청했어요';
      $('undoAccept').hidden = mineReq || !mem;
      $('undoDecline').hidden = mineReq || !mem;
      $('undoCancel').hidden = !mineReq;
    } else bn.hidden = true;
  }

  function renderPlaceBtn() {
    var b = $('placeBtn');
    b.hidden = !(ui.pending && canMove() && !ui.forb.some(function (f) { return same(f, ui.pending); }));
  }

  function renderNet() {
    var n = clients.filter(function (c) { return c && c.connected; }).length;
    var el = $('netBadge');
    el.classList.toggle('ok', n > 0);
    el.classList.toggle('bad', n === 0 && everConnected);
    el.querySelector('em').textContent = n > 0 ? '연결됨' : (everConnected ? '다시 연결 중…' : '연결 중…');
    el.title = '중계 서버 ' + n + '/' + BROKERS.length + '곳 연결';
  }

  function updateTitle() {
    var normal = '오목 · ' + room.toUpperCase();
    document.title = (cur && document.hidden && canMove()) ? '● 내 차례! · 오목' : normal;
  }

  function renderNameModal() {
    var t = $('nameTitle'), s = $('nameSub');
    if (cur && cur.players.guest && !isMember()) { t.textContent = '관전하러 오셨네요'; s.textContent = '이미 두 사람이 대국 중이에요. 이름을 적고 관전하세요.'; }
    else if (cur) { t.textContent = cur.players.host.name + '님이 오목 한 판 하재요!'; s.textContent = '이름을 적고 입장하세요.'; }
  }

  function inviteUrl() { return location.origin + location.pathname + '?r=' + room; }
  function copyText(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { }
      ta.remove();
      toast(ok ? '초대 링크를 복사했어요' : '복사가 안 되면 링크를 길게 눌러 복사해 주세요');
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('초대 링크를 복사했어요'); }, fallback);
    else fallback();
  }
  function shareInvite() {
    var url = inviteUrl();
    if (navigator.share) {
      navigator.share({ title: '오목 한 판 두자!', text: (myName || '친구') + '님이 오목 한 판 하재요! 링크를 누르면 바로 시작해요.', url: url })
        .catch(function (e) { if (e && e.name !== 'AbortError') copyText(url); });
    } else copyText(url);
  }

  /* ================= 대국실 시작 ================= */
  function bindRoomUI() {
    cv = $('board'); ctx = cv.getContext('2d');
    if (window.ResizeObserver) new ResizeObserver(resizeBoard).observe(cv);
    window.addEventListener('resize', resizeBoard);
    resizeBoard();

    cv.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse') return;
      var c = cellAt(e);
      if (!same(c, ui.hover)) { ui.hover = c; draw(); }
    });
    cv.addEventListener('pointerleave', function () { if (ui.hover) { ui.hover = null; draw(); } });
    cv.addEventListener('pointerup', function (e) {
      var c = cellAt(e);
      if (c) onCellTap(c, e.pointerType !== 'mouse');
    });
    $('placeBtn').onclick = function () { if (ui.pending) place(ui.pending); };

    $('codeChip').onclick = function () { copyText(inviteUrl()); };
    $('copyBtn').onclick = function () { copyText(inviteUrl()); };
    $('shareBtn').onclick = shareInvite;

    $('undoBtn').onclick = function () {
      var mc = myColor();
      if (!cur || cur.undo || !mc) return;
      commit(function (s) { s.undo = { by: mc, n: s.moves.length }; });
      toast('무르기를 요청했어요');
    };
    $('undoAccept').onclick = function () {
      if (!cur || !cur.undo) return;
      var ok = cur.undo.n === cur.moves.length;
      commit(function (s) { if (ok) s.moves.pop(); s.undo = null; });
    };
    $('undoDecline').onclick = function () { if (cur && cur.undo) commit(function (s) { s.undo = null; }); };
    $('undoCancel').onclick = function () { if (cur && cur.undo) commit(function (s) { s.undo = null; }); };

    $('resignBtn').onclick = function () { $('resignConfirm').hidden = false; renderActions(); };
    $('resignNo').onclick = function () { $('resignConfirm').hidden = true; renderActions(); };
    $('resignYes').onclick = function () {
      $('resignConfirm').hidden = true;
      var mc = myColor();
      if (!cur || cur.status !== 'playing' || !mc) return;
      var w = other(mc);
      commit(function (s) {
        s.status = 'ended'; s.undo = null;
        s.result = { winner: w, reason: 'resign' };
        var wr = s.hostColor === w ? 'host' : 'guest';
        s.score[wr] = (s.score[wr] || 0) + 1;
      });
    };
    function rematch() {
      if (!cur || cur.status !== 'ended' || !isMember()) return;
      commit(function (s) {
        s.game = (s.game || 1) + 1;
        s.hostColor = other(s.hostColor);
        s.moves = []; s.result = null; s.undo = null;
        s.status = s.players.guest ? 'playing' : 'waiting';
      });
    }
    $('rematchBtn').onclick = rematch;
    $('rematchBtn2').onclick = rematch;
    $('closeResultBtn').onclick = function () { ui.resultHidden = true; render(); };

    // 토글
    var coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    $('tConfirm').hidden = !coarse;
    function bindToggle(id, key) {
      var b = $(id);
      b.setAttribute('aria-pressed', String(prefs[key]));
      b.onclick = function () {
        prefs[key] = !prefs[key];
        store.set('omok.' + key, prefs[key] ? '1' : '0');
        b.setAttribute('aria-pressed', String(prefs[key]));
        if (key === 'confirm') { ui.pending = null; renderPlaceBtn(); }
        draw();
      };
    }
    bindToggle('tSound', 'sound'); bindToggle('tNum', 'num'); bindToggle('tConfirm', 'confirm');

    // 채팅
    $('chatForm').addEventListener('submit', function (e) {
      e.preventDefault();
      sendChat($('chatInput').value);
      $('chatInput').value = '';
    });
    $('quick').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (b) sendChat(b.textContent);
    });
    var li = document.createElement('li'); li.className = 'empty'; li.textContent = '친구에게 한마디 남겨 보세요';
    $('msgs').appendChild(li);

    // 이름 입력
    $('nameForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = $('nameInput').value.trim();
      if (!v) { $('nameInput').focus(); return; }
      setName(v);
      $('nameModal').hidden = true;
      unlockAudio();
      sendPresence();
      autoSeat();
      render();
    });

    document.addEventListener('visibilitychange', function () {
      updateTitle();
      if (!document.hidden) {
        clients.forEach(function (c) { if (c && !c.connected && !c.reconnecting) try { c.reconnect(); } catch (e) { } });
        sendPresence();
        renderPlayers();
      }
    });
    window.addEventListener('pagehide', function () { pubAll('p/' + myId, { id: myId, off: 1 }); });
    window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
  }

  function enterRoom(code, initial) {
    room = code; base = TOPIC_ROOT + room + '/';
    $('room').hidden = false;
    $('roomCode').textContent = room.toUpperCase();
    joinedAt = Date.now();
    bindRoomUI();
    if (initial) applyState(initial, true);
    if (!myName) { $('nameModal').hidden = false; renderNameModal(); setTimeout(function () { $('nameInput').focus(); }, 50); }
    connectNet();
    render();
    setInterval(function () { sendPresence(); renderPlayers(); }, BEAT_MS);
    setInterval(function () { if (cur) renderPlayers(); }, 3000);
    setTimeout(function () {
      if (!cur) $('status').textContent = '방을 찾는 중… 방을 만든 친구가 접속해 있으면 곧 연결돼요. (방 코드: ' + room.toUpperCase() + ')';
    }, 7000);
  }

  window.addEventListener('popstate', function () { location.reload(); });

  var code = cleanCode(params.get('r'));
  if (code.length >= 4) enterRoom(code, null);
  else showLobby();
})();
