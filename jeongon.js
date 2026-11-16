/* 정온시설 위치도 (시험판): 지구계(도면 탭) 기준 검토 범위 안의 정온시설(주거·교육·의료·종교·노유자 등)을
 * 브이월드 건물통합정보(연속수치지형도 건물 + 건축물대장 용도)로 찾고, 마을 단위로 묶어 그룹마다 가장 가까운 대표 시설과 이격거리를 계산.
 * 자동 결과는 초안: 표에서 빼기·이름 바꾸기 가능. app2.js 앞에 로드. */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const USE = {   // 건축물대장 주용도 코드 → 이름
    '01000': '단독주택', '02000': '공동주택', '03000': '제1종근린생활시설', '04000': '제2종근린생활시설', '05000': '문화및집회시설', '06000': '종교시설',
    '07000': '판매시설', '08000': '운수시설', '09000': '의료시설', '10000': '교육연구시설', '11000': '노유자시설', '12000': '수련시설', '13000': '운동시설',
    '14000': '업무시설', '15000': '숙박시설', '16000': '위락시설', '17000': '공장', '18000': '창고시설', '19000': '위험물저장및처리시설', '20000': '자동차관련시설',
    '21000': '동물및식물관련시설', '22000': '자원순환관련시설', '23000': '교정시설', '24000': '국방·군사시설', '25000': '방송통신시설', '26000': '발전시설', '27000': '묘지관련시설',
    '28000': '관광휴게시설', '29000': '장례시설' };
  const PICK = [['01000', '단독주택'], ['02000', '공동주택'], ['10000', '교육연구시설 (학교 등)'], ['09000', '의료시설'], ['11000', '노유자시설'], ['06000', '종교시설'], ['12000', '수련시설'], ['none', '용도 없음 (대장 미등록)']];
  const HOUSE = new Set(['01000', '02000', 'none']);   // 마을로 묶는 용도 (나머지는 시설별로 따로)
  const DIR = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  const O = () => { const o = App.opts.quiet = App.opts.quiet || {}; if (o.buf == null) o.buf = 300; if (!o.uses) o.uses = ['01000', '02000', '10000', '09000', '11000', '06000']; if (o.eps == null) o.eps = 40; if (o.minN == null) o.minN = 3; if (!o.names) o.names = {}; if (!o.off) o.off = {}; if (o.outOnly == null) o.outOnly = true; return o; };
  const esc = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const refresh = () => { App.liveSets.forEach(s => s.changed && s.changed()); if (App.layout && App.layout.redraw) App.layout.redraw(); App.emit(); };
  const rd = new jsts.io.GeoJSONReader(), wr = new jsts.io.GeoJSONWriter(), fmt3857 = new ol.format.GeoJSON();
  const GF = new jsts.geom.GeometryFactory();
  const fixRing = g => (g.getGeometryType && g.getGeometryType() === 'LinearRing' ? GF.createLineString(g.getCoordinates()) : g);   // 쓰기 도구가 LinearRing을 못 써서 선으로 바꿈
  const to3857 = g => fmt3857.readGeometry(wr.write(fixRing(g)), { dataProjection: 'EPSG:5186', featureProjection: 'EPSG:3857' });
  let B = null;        // { blds: [{g, use, name, fl, env}], admins: [{g, name}], site, bbox }
  let groups = [];

  // ------------------------------------------------------------ 자료 받기 (브이월드 2D데이터 API, JSONP)
  const tr4 = c => (typeof c[0] === 'number' ? proj4('EPSG:4326', 'EPSG:5186', [c[0], c[1]]) : c.map(tr4));
  async function vw(data, box4, extra) {
    const out = []; let page = 1, total = 1;
    while ((page - 1) * 1000 < total && page <= 20) {
      const u = `https://api.vworld.kr/req/data?service=data&request=GetFeature&data=${data}&key=${App.cfg.vworldKey}&domain=${encodeURIComponent(location.origin)}&format=json&size=1000&page=${page}&geometry=true&attribute=true&crs=EPSG:4326&geomFilter=BOX(${box4.join(',')})${extra || ''}`;
      const j = await App.jsonp(u), r = j.response;
      if (!r || r.status === 'NOT_FOUND') break;
      if (r.status !== 'OK') throw new Error((r.error && r.error.text) || r.status);
      total = Number(r.record && r.record.total) || 0;
      ((r.result && r.result.featureCollection && r.result.featureCollection.features) || []).forEach(f => out.push(f));
      page++;
    }
    return out;
  }
  function boxes4(b5, step) {   // 큰 범위는 조각으로 (요청 면적 제한)
    const out = [];
    for (let x = b5[0]; x < b5[2]; x += step) for (let y = b5[1]; y < b5[3]; y += step) {
      const a = proj4('EPSG:5186', 'EPSG:4326', [x, y]), c = proj4('EPSG:5186', 'EPSG:4326', [Math.min(x + step, b5[2]), Math.min(y + step, b5[3])]);
      out.push([a[0], a[1], c[0], c[1]].map(v => +v.toFixed(6)));
    }
    return out;
  }
  async function load() {
    const o = O(), msg = $('#qMsg'), btn = $('#btnQRun');
    const sites = App.sites.filter(s => s.geometry);
    if (!sites.length) { App.toast('먼저 도면 탭에서 지구계 도면을 올리세요.', 'warn'); return; }
    if (!App.cfg.vworldKey) { App.toast('브이월드 키가 필요합니다.', 'warn'); return; }
    let site = null; sites.forEach(s => { const g = rd.read(s.geometry); site = site ? site.union(g) : g; });
    const buf = Math.max(50, Number(o.buf) || 300), env = site.getEnvelopeInternal(), m = buf + 80;
    const b5 = [env.getMinX() - m, env.getMinY() - m, env.getMaxX() + m, env.getMaxY() + m];
    btn.disabled = true; msg.hidden = false;
    try {
      const bx = boxes4(b5, 1200), seen = new Set(), blds = [];
      for (let i = 0; i < bx.length; i++) {
        msg.textContent = `건물 받는 중... ${i + 1} / ${bx.length} 구역`;
        (await vw('LT_C_BLDGINFO', bx[i])).forEach(f => {
          if (!f.geometry) return; const k = JSON.stringify(f.geometry.coordinates).slice(0, 120); if (seen.has(k)) return; seen.add(k);
          let g; try { g = rd.read({ type: f.geometry.type, coordinates: tr4(f.geometry.coordinates) }); if (!g.isValid()) g = g.buffer(0); } catch (e) { return; }
          const p = f.properties || {};
          blds.push({ g, env: g.getEnvelopeInternal(), use: p.usability || 'none', name: (p.bld_nm || '').trim(), fl: Number(p.grnd_flr) || 0 });
        });
      }
      msg.textContent = '행정구역(리·동) 받는 중...';
      const whole = boxes4(b5, Math.max(b5[2] - b5[0], b5[3] - b5[1]) + 1)[0], admins = [];
      for (const [data, key] of [['LT_C_ADRI_INFO', 'li_kor_nm'], ['LT_C_ADEMD_INFO', 'emd_kor_nm']]) {
        try { (await vw(data, whole)).forEach(f => { try { admins.push({ g: rd.read({ type: f.geometry.type, coordinates: tr4(f.geometry.coordinates) }), name: (f.properties || {})[key] || '', lv: data }); } catch (e) { /* 건너뜀 */ } }); } catch (e) { /* 없어도 진행 */ }
      }
      B = { blds, admins, site, buf, bufG: site.buffer(buf, 16) };
      regroup();
      msg.textContent = `완료: 건물 ${blds.length.toLocaleString()}동 · 정온시설 그룹 ${groups.length}곳 (검토 범위 ${buf}m)`;
      if (App.layout && App.layout.fit && App.embedView && App.embedView.quiet === 'print') App.layout.fit();
    } catch (e) { msg.textContent = '오류: ' + e.message; }
    finally { btn.disabled = false; }
  }

  // ------------------------------------------------------------ 그룹 만들기
  function areaName(pt) {
    const p = new jsts.geom.GeometryFactory().createPoint(new jsts.geom.Coordinate(pt[0], pt[1]));
    const li = B.admins.find(a => a.lv === 'LT_C_ADRI_INFO' && a.name && a.g.contains(p)); if (li) return li.name;
    const em = B.admins.find(a => a.lv === 'LT_C_ADEMD_INFO' && a.name && a.g.contains(p)); return em ? em.name : '';
  }
  function cluster(items, eps, sameKey) {   // 가까운 건물끼리(eps 이내) 이어서 묶기
    const n = items.length, grp = new Array(n).fill(-1); let k = 0;
    for (let i = 0; i < n; i++) {
      if (grp[i] >= 0) continue; grp[i] = k; const st = [i];
      while (st.length) {
        const a = items[st.pop()];
        for (let j = 0; j < n; j++) {
          if (grp[j] >= 0) continue; const b = items[j];
          if (sameKey && sameKey(a) !== sameKey(b)) continue;
          if (a.env.distance(b.env) > eps) continue;
          if (a.g.distance(b.g) <= eps) { grp[j] = k; st.push(j); }
        }
      }
      k++;
    }
    const out = []; items.forEach((it, i) => { (out[grp[i]] = out[grp[i]] || []).push(it); }); return out;
  }
  function regroup() {
    if (!B) return;
    const o = O(), uses = new Set(o.uses);
    const cand = B.blds.filter(b => uses.has(b.use) && b.g.intersects(B.bufG) && !(o.outOnly && B.site.contains(b.g.getInteriorPoint())));   // 지구계 안 건물은 제외 (선택)
    B.blds.forEach(b => { b.cand = false; b.rep = false; }); cand.forEach(b => { b.cand = true; b.d = b.g.distance(B.site); });
    const eps = Math.max(5, Number(o.eps) || 40), minN = Math.max(2, Number(o.minN) || 3);
    const out = [];
    // 1) 마을: 주거용(단독·공동주택·용도 없음). 이름 있는 아파트 단지는 단지별로
    const apt = cand.filter(b => b.use === '02000' && b.name);
    const house = cand.filter(b => HOUSE.has(b.use) && !(b.use === '02000' && b.name));
    cluster(apt, eps, b => b.name.replace(/\s*\d+동$/, '')).forEach(ms => out.push({ kind: '공동주택', ms, nm: ms[0].name.replace(/\s*\d+동$/, '') }));
    cluster(house, eps).forEach(ms => { if (ms.length >= minN) out.push({ kind: '마을', ms }); else ms.forEach(b => out.push({ kind: '단독가옥', ms: [b] })); });
    // 2) 시설: 교육·의료·노유자·종교·수련 등은 시설별로 따로 (같은 이름·용도로 붙어 있으면 한 시설)
    const fac = cand.filter(b => !HOUSE.has(b.use));
    cluster(fac, 15, b => b.use + '|' + b.name).forEach(ms => out.push({ kind: '시설', ms, nm: ms.find(x => x.name) ? ms.find(x => x.name).name : USE[ms[0].use] }));
    // 대표 = 지구계와 가장 가까운 건물
    out.forEach(gp => {
      gp.rep = gp.ms.reduce((a, b) => (b.d < a.d ? b : a)); gp.rep.rep = true; gp.d = gp.rep.d;
      const np = jsts.operation.distance.DistanceOp.nearestPoints(B.site, gp.rep.g); const dx = np[1].x - np[0].x, dy = np[1].y - np[0].y;
      gp.dir = gp.d < 0.5 ? '-' : DIR[Math.round(((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360 / 45) % 8];
      const c = gp.rep.g.getCentroid().getCoordinate(); gp.area = areaName([c.x, c.y]);
      gp.key = gp.kind + '|' + Math.round(c.x) + '|' + Math.round(c.y);
    });
    out.sort((a, b) => a.d - b.d);
    // 이름: 마을은 '리(동)이름 + 마을 + 순번', 단독가옥은 층수 표시
    const perArea = {}; out.filter(g => g.kind === '마을').forEach(g => { perArea[g.area] = (perArea[g.area] || 0) + 1; });
    const seq = {};
    out.forEach((g, i) => {
      g.no = i + 1;
      if (g.kind === '마을') { seq[g.area] = (seq[g.area] || 0) + 1; g.auto = `${g.area || ''}마을${perArea[g.area] > 1 ? seq[g.area] : ''}`; }
      else if (g.kind === '단독가옥') g.auto = '단독가옥' + (g.rep.fl >= 2 ? `(${g.rep.fl}F)` : '');
      else g.auto = g.nm || USE[g.rep.use] || '시설';
      g.name = o.names[g.key] || g.auto; g.on = o.off[g.key] !== true;
    });
    groups = out;
    // 표시 번호는 켜진 것만 차례로
    let n = 0; groups.forEach(g => { g.no = g.on ? ++n : null; });
    draw(); renderTable(); refresh();
  }

  // ------------------------------------------------------------ 지도
  function draw() {
    const src = App.src.quiet; src.clear();
    if (!B) return;
    const add = (g, props) => { const f = new ol.Feature(to3857(g)); f.setProperties(props); src.addFeature(f); return f; };
    { const bd = B.bufG.getBoundary(); if (bd.getGeometryType() === 'MultiLineString' || bd.getGeometryType() === 'LineString' || bd.getGeometryType() === 'LinearRing') add(bd, { qk: 'buf' }); else for (let i = 0; i < bd.getNumGeometries(); i++) add(bd.getGeometryN(i), { qk: 'buf' }); }
    // 화면 범위 안 건물만 (회색 배경 + 정온시설)
    const view = B.bufG.buffer(150);
    B.blds.forEach(b => { if (b.rep) return; if (!b.cand && !b.env.intersects(view.getEnvelopeInternal())) return; add(b.g, { qk: b.cand ? 'cand' : 'bld' }); });
    groups.forEach(g => {
      if (!g.on) { add(g.rep.g, { qk: 'cand' }); return; }
      add(g.rep.g, { qk: 'rep' });
      let hull; try { const all = g.ms.map(b => b.g).reduce((a, b) => a.union(b)); hull = all.convexHull().buffer(g.ms.length > 1 ? 12 : 7, 8); } catch (e) { hull = g.rep.g.buffer(7); }
      const ring = add(hull.getBoundary(), { qk: 'hull' });
      // 이름표: 테두리 위쪽 가운데
      const e = hull.getEnvelopeInternal(), top = [(e.getMinX() + e.getMaxX()) / 2, e.getMaxY()];
      const lf = new ol.Feature(new ol.geom.Point(ol.proj.transform(proj4('EPSG:5186', 'EPSG:4326', top), 'EPSG:4326', 'EPSG:3857')));
      lf.setProperties({ qk: 'label', text: `${g.no}.${g.name}`, gkey: g.key }); src.addFeature(lf); ring.set('gkey', g.key);
    });
  }
  const ST = {};
  App.quietStyle = function (f, s) {
    if (App.theme !== 'quiet') return null;
    const k = f.get('qk'), o = O(), fs = (Number(o.fontPct) || 100) / 100;
    if (k === 'label') {
      const off = (O().lpos || {})[f.get('gkey')];
      return new ol.style.Style({ text: new ol.style.Text({ text: f.get('text'), font: `bold ${Math.round(12 * fs * s * 10) / 10}px "EcoFont","Malgun Gothic",sans-serif`, offsetY: -9 * fs * s,
        fill: new ol.style.Fill({ color: '#111' }), stroke: new ol.style.Stroke({ color: '#fff', width: 3.5 * s }), overflow: true }), geometry: off ? new ol.geom.Point(off) : undefined });
    }
    const key = k + s.toFixed(2);
    if (!ST[key]) ST[key] = {
      buf: new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#111', width: 1.8 * s }) }),
      hull: new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#111', width: 1.2 * s }) }),
      rep: new ol.style.Style({ fill: new ol.style.Fill({ color: '#111' }), stroke: new ol.style.Stroke({ color: '#111', width: 1 * s }) }),
      cand: new ol.style.Style({ fill: new ol.style.Fill({ color: 'rgba(120,120,120,0.35)' }), stroke: new ol.style.Stroke({ color: '#555', width: 0.7 * s }) }),
      bld: new ol.style.Style({ stroke: new ol.style.Stroke({ color: '#9a9a9a', width: 0.6 * s }) }),
    }[k];
    return ST[key] || null;
  };
  App.quietLegend = function () {
    if (!B) return [];
    return [{ t: '대표 정온시설', sym: { shape: 'square', color: '#111' } }, { t: '정온시설 그룹', prot: { color: '#111', dash: 'solid', id: 'q' } }, { t: `검토 범위 (${B.buf}m)`, prot: { line: true, color: '#111' } }];
  };

  // ------------------------------------------------------------ 표
  function renderTable() {
    const box = $('#qTable'); if (!groups.length) { box.innerHTML = B ? '<div class="hint">검토 범위 안에 고른 용도의 건물이 없습니다.</div>' : ''; return; }
    box.innerHTML = `<table class="lc-tbl q-tbl"><tr><th></th><th>번호</th><th>이름</th><th>건물</th><th>대표 시설</th><th>이격거리</th><th>방향</th></tr>` +
      groups.map((g, i) => `<tr class="${g.on ? '' : 'off'}"><td><input type="checkbox" data-qon="${i}" ${g.on ? 'checked' : ''} title="포함"></td><td>${g.no || '-'}</td>
        <td><input type="text" class="q-nm" data-qnm="${i}" value="${esc(g.name)}"></td><td>${g.ms.length}동</td>
        <td>${esc(USE[g.rep.use] || '용도 없음')}${g.rep.fl ? ` ${g.rep.fl}층` : ''}</td><td>${g.d < 0.5 ? '0 (경계 안)' : '약 ' + Math.round(g.d).toLocaleString() + 'm'}</td><td>${g.dir}</td></tr>`).join('') + '</table>';
  }
  function copyTable() {
    const lines = [['번호', '이름', '구분', '건물 수', '대표 시설 용도', '층수', '이격거리(m)', '방향'].join('\t')];
    groups.filter(g => g.on).forEach(g => lines.push([g.no, g.name, g.kind, g.ms.length, USE[g.rep.use] || '용도 없음', g.rep.fl || '', Math.round(g.d), g.dir].join('\t')));
    navigator.clipboard.writeText(lines.join('\n')).then(() => App.toast('표를 복사했습니다.', 'ok'), () => App.toast('복사하지 못했습니다.', 'warn'));
  }

  function build() {
    const o = O();
    $('#qBuf').value = o.buf; $('#qEps').value = o.eps; $('#qMinN').value = o.minN; $('#qFont').value = o.fontPct || 100;
    $('#qUses').innerHTML = PICK.map(([c, n]) => `<label class="check"><input type="checkbox" data-quse="${c}" ${o.uses.includes(c) ? 'checked' : ''}> ${n}</label>`).join('');
    $('#btnQRun').addEventListener('click', load);
    const re = () => { App.saveOpts(); if (B) regroup(); };
    $('#qBuf').addEventListener('change', e => { o.buf = Math.max(50, Number(e.target.value) || 300); App.saveOpts(); if (B) { B.buf = o.buf; B.bufG = B.site.buffer(o.buf, 16); regroup(); } });
    $('#qEps').addEventListener('change', e => { o.eps = Math.max(5, Number(e.target.value) || 40); re(); });
    $('#qMinN').addEventListener('change', e => { o.minN = Math.max(2, Number(e.target.value) || 3); re(); });
    $('#qFont').addEventListener('input', e => { o.fontPct = Math.max(30, Number(e.target.value) || 100); App.saveOpts(); refresh(); });
    $('#qOut').checked = o.outOnly !== false; $('#qOut').addEventListener('change', e => { o.outOnly = e.target.checked; re(); });
    $('#qUses').addEventListener('change', e => { const c = e.target.dataset.quse; if (!c) return; o.uses = o.uses.filter(x => x !== c); if (e.target.checked) o.uses.push(c); re(); });
    $('#qTable').addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.qon != null) { const g = groups[+t.dataset.qon]; if (t.checked) delete o.off[g.key]; else o.off[g.key] = true; re(); return; }
      if (t.dataset.qnm != null) { const g = groups[+t.dataset.qnm]; const v = t.value.trim(); if (v && v !== g.auto) o.names[g.key] = v; else delete o.names[g.key]; re(); }
    });
    $('#btnQCopy').addEventListener('click', copyTable);
    $('#btnQReset').addEventListener('click', () => { o.names = {}; o.off = {}; o.lpos = {}; re(); });
  }
  // 미리보기에서 이름표 끌기
  App.quietLabelHit = function (map, px) {
    if (App.theme !== 'quiet') return null; let best = null, bd = 26;
    App.src.quiet.getFeatures().forEach(f => { if (f.get('qk') !== 'label') return; const c = (O().lpos || {})[f.get('gkey')] || f.getGeometry().getCoordinates(); const q = map.getPixelFromCoordinate(c); if (!q) return; const d = Math.hypot(q[0] - px[0], q[1] - px[1] + 9); if (d < bd) { bd = d; best = f; } });
    return best;
  };
  App.quietLabelMove = function (f, coord) { const o = O(); o.lpos = o.lpos || {}; o.lpos[f.get('gkey')] = coord; App.liveSets.forEach(s => s.changed && s.changed()); };
  App.quietSave = () => App.saveOpts();
  const origInit = App.init;
  App.init = async function () { await origInit.apply(this, arguments); build(); };
})();
