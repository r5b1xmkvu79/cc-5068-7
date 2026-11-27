const $ = (id) => document.getElementById(id);
const state = {
  clips: [], index: null, lastResults: [], marks: new Map(), queryGroup: null,
  acceptQueries: [], acceptQueryIds: new Set(),
};

const BLOCK_CN = {
  spectral: '频谱形状', envelope: '时间包络', pitch: '音高',
  loudness: '绝对响度', duration: '时长',
};
const FEATURE_CN = {
  specCentroid: '频谱质心', specBandwidth: '频谱带宽', specRolloff85: '85%滚降频率',
  specFlatness: '频谱平坦度', specSkew: '频谱偏度', specKurt: '频谱峰度',
  specHfRatio: '高频能量占比', lowMidRatio: '低/中频能量比',
  attackTime: '起振时间', decayTau: '衰减时间常数', envFlatness: '包络平坦度',
  envSustain: '尾部维持比', transientRatio: '瞬态对比', onsetSlope: '起振斜率(dB/s)',
  f0: '基频 F0', f0Confidence: '音高置信度', inharmonicity: '非谐和度',
  rmsDb: '平均响度 RMS', peakDb: '峰值电平', crestDb: '波峰因子',
  duration: '时长(s)',
};

const api = async (route, body) => {
  const opt = body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : {};
  const r = await fetch(route, opt);
  if (!r.ok) throw new Error((await r.json()).error || r.status);
  return r.json();
};

// ---------- canvas helpers ----------
function drawSeries(canvas, data, color = '#5db3ff', zero = true) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const max = Math.max(1e-6, ...data.map((v) => Math.abs(v)));
  ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
  if (zero) { ctx.strokeStyle = '#2c3a4c'; ctx.beginPath(); ctx.moveTo(0, canvas.height / 2); ctx.lineTo(canvas.width, canvas.height / 2); ctx.stroke(); ctx.beginPath(); ctx.strokeStyle = color; }
  data.forEach((v, i) => {
    const x = (i / (data.length - 1)) * canvas.width;
    const y = zero ? canvas.height / 2 - (v / max) * (canvas.height / 2 - 4)
      : canvas.height - (v / max) * (canvas.height - 6);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

function drawSpecgram(canvas, curves) {
  const { specgram, tBins, fBins } = curves;
  const ctx = canvas.getContext('2d');
  let lo = Infinity, hi = -Infinity;
  for (const v of specgram) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const img = ctx.createImageData(canvas.width, canvas.height);
  const cw = canvas.width / tBins, ch = canvas.height / fBins;
  for (let t = 0; t < tBins; t++) {
    for (let f = 0; f < fBins; f++) {
      const v = (specgram[t * fBins + (fBins - 1 - f)] - lo) / (hi - lo + 1e-9);
      // blue -> teal -> yellow heat map
      const r = Math.round(30 + v * 225 * Math.max(0, v - 0.55) * 2.2);
      const g = Math.round(40 + v * 200);
      const b = Math.round(90 + (1 - v) * 120);
      for (let px = 0; px < Math.ceil(cw); px++) for (let py = 0; py < Math.ceil(ch); py++) {
        const x = Math.floor(t * cw + px), y = Math.floor(f * ch + py);
        if (x >= canvas.width || y >= canvas.height) continue;
        const o = (y * canvas.width + x) * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = '#8fa0b5'; ctx.font = '10px monospace';
  ctx.fillText('时间 →', canvas.width - 52, canvas.height - 6);
  ctx.save(); ctx.translate(12, 14); ctx.fillText('频率 ↑', 0, 0); ctx.restore();
}

// ---------- analysis window ----------
async function showAnalysis(id) {
  const mode = $('modeSelect').value;
  const isAccept = state.acceptQueryIds.has(id);
  const data = isAccept
    ? await api(`/api/accept/features?id=${encodeURIComponent(id)}`)
    : await api(`/api/features?id=${encodeURIComponent(id)}&mode=${mode}`);
  $('queryId').textContent = isAccept ? `${id}（验收回归样例）` : id;
  $('queryAudio').src = isAccept
    ? `/audio/accept/${id}.wav`
    : `/audio/${id}.wav?mode=${mode}`;
  drawSeries($('waveCanvas'), data.curves.waveform);
  drawSpecgram($('specCanvas'), data.curves);
  drawSeries($('envCanvas'), data.curves.envelope, '#65d18a', false);
  const order = [
    ...Object.keys(data.features).filter((k) => !['rmsDb', 'peakDb', 'crestDb', 'duration'].includes(k)),
    'rmsDb', 'peakDb', 'crestDb', 'duration',
  ];
  $('featureTable').innerHTML = order.map((k) => {
    const v = data.features[k];
    const blocked = ['rmsDb', 'peakDb', 'crestDb', 'duration'].includes(k);
    return `<div class="f" title="${blocked ? '默认音色距离中排除' : ''}">
      <b>${FEATURE_CN[k] || k}${blocked ? ' *' : ''}</b><span>${format(v, k)}</span></div>`;
  }).join('');
}
const format = (v, k) => {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(3);
};

// ---------- search ----------
function currentOptions() {
  const mode = $('modeSelect').value;
  return {
    target: $('targetSelect').value,
    loudnessMode: mode,
    metric: $('metricSelect').value,
    usePitch: $('pitchToggle').checked,
    useLoudness: $('loudToggle').checked ? true : (mode === 'raw' ? undefined : false),
    excludeGroups: $('leakToggle').checked && state.queryGroup ? [state.queryGroup] : [],
  };
}

async function runSearch(adapted = false) {
  const queryId = $('querySelect').value;
  const isAccept = state.acceptQueryIds.has(queryId);
  const clip = state.clips.find((c) => c.id === queryId);
  state.queryGroup = clip ? clip.group : null;
  const opts = currentOptions();
  let out;
  if (isAccept) {
    // 回归样例：索引外查询，复用训练集拟合的统计量，实际运算。
    out = await api('/api/accept/search', { queryId, ...opts });
  } else {
    out = adapted
      ? await api('/api/feedback', {
        queryId, ...opts,
        relevant: [...state.marks].filter(([, v]) => v === 'rel').map(([id]) => id),
        irrelevant: [...state.marks].filter(([, v]) => v === 'irr').map(([id]) => id),
      })
      : await api('/api/search', { queryId, ...opts });
  }
  state.lastResults = out.results;
  renderResults(out);
  updateModeHint(out);
}

function updateModeHint(out) {
  if (out.loudnessMode === 'eq') {
    $('modeHint').textContent = '等响度索引：所有候选 RMS 已拉平，前级增益差异被显式消除；排序只反映音色描述符。';
  } else {
    $('modeHint').textContent = out.useLoudness
      ? '原动态索引：保留录音电平，且距离中包含绝对响度块——同增益录音会被拉近，这是可在评估页量化的效应而非缺陷。'
      : '原动态索引但关闭响度块：波形保留动态，距离仍只看音色，用于隔离“响度”这一个变量。';
  }
}

function renderResults(out) {
  const mode = out.loudnessMode;
  $('results').innerHTML = out.results.slice(0, 12).map((r, i) => {
    const mark = state.marks.get(r.id);
    const why = r.explanation.slice(0, 5).map((e) => {
      const cls = e.block === 'loudness' ? 'loudness' : e.block === 'pitch' ? 'pitch' : '';
      const pct = Math.min(100, (e.absDelta / 3) * 100);
      return `<div class="bar">
        <span>${FEATURE_CN[e.feature] || e.feature} <small>(${BLOCK_CN[e.block]})</small></span>
        <span class="track"><span class="fill ${cls}" style="width:${pct.toFixed(1)}%"></span></span>
        <span>Δz=${e.deltaZ}</span></div>`;
    }).join('');
    return `<div class="result" data-id="${r.id}">
      <div class="top">
        <span class="rank">#${i + 1}</span>
        <span class="mono">${r.id}</span>
        <span class="sim">相似度 ${(r.similarity).toFixed(3)}</span>
        <span class="dist">距离 ${r.distance}</span>
        <span class="tag">${r.gainTag || 'flat'} 增益</span>
        <span class="mark-btns">
          <button class="rel ${mark === 'rel' ? 'on' : ''}" data-mark="rel">相近</button>
          <button class="irr ${mark === 'irr' ? 'on' : ''}" data-mark="irr">不符</button>
        </span>
      </div>
      <audio controls preload="none" src="/audio/${r.id}.wav?mode=${mode}"></audio>
      <div class="why"><b>主要相似依据 / 差异：</b>${why}</div>
    </div>`;
  }).join('');
  $('results').querySelectorAll('.mark-btns').forEach((box) => {
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const id = box.closest('.result').dataset.id;
      state.marks.set(id, btn.dataset.mark);
      runSearch(false).then(() => { /* keep marks; re-render restores classes */ });
    });
  });
}

// ---------- door film ----------
const film = { timer: null, start: 0, events: [] };

function doorEvents() {
  const main = state.clips.filter((c) => c.kind === 'main');
  const find = (prop, force, gainTag) =>
    main.find((c) => c.prop === prop && c.force === force && c.gainTag === gainTag);
  return [
    { t: 1.0, queryId: find('P1', 'light', 'hi').id },
    { t: 3.2, queryId: find('P2', 'heavy', 'hi').id },
    { t: 5.4, queryId: find('P1', 'light', 'lo').id },
  ];
}

function drawDoor(openAmt, flash) {
  const c = $('doorCanvas'), ctx = c.getContext('2d');
  ctx.fillStyle = '#0b1017'; ctx.fillRect(0, 0, c.width, c.height);
  // frame
  ctx.strokeStyle = '#2c3a4c'; ctx.lineWidth = 6; ctx.strokeRect(60, 30, 240, 200);
  // door slab rotating around left hinge
  const w = 220 * (1 - openAmt * 0.75);
  ctx.fillStyle = flash ? '#3a4a5f' : '#243141';
  ctx.fillRect(66, 36, w, 188);
  ctx.strokeStyle = '#3d5067'; ctx.strokeRect(66, 36, w, 188);
  ctx.fillStyle = '#c9d6e5';
  ctx.beginPath(); ctx.arc(66 + w - 14, 130, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8fa0b5'; ctx.font = '12px sans-serif';
  ctx.fillText('关门事件时间轴（替换轨驱动）', 70, 250);
}

async function buildReplacementTrack() {
  const events = doorEvents();
  const excludeGroups = [...new Set(events.map((e) =>
    state.clips.find((c) => c.id === e.queryId).group))];
  const summary = await api('/api/replace', {
    events, ...currentOptions(), excludeGroups,
  });
  film.events = summary.placements;
  $('placementList').innerHTML = summary.placements.map((p) =>
    `<div class="placement">t=${p.eventTime}s：查询 <span class="mono">${p.query}</span>
     → 替换为 <span class="mono">${p.replacement}</span>（相似度 ${p.similarity}）</div>`).join('');
  $('replaceAudio').src = `/replacement.wav?ts=${Date.now()}`;
  $('replaceDownload').href = $('replaceAudio').src;
  return summary;
}

function playFilm() {
  stopFilm();
  const audio = $('replaceAudio');
  audio.currentTime = 0;
  audio.play();
  film.start = performance.now() / 1000;
  const dur = 7;
  drawDoor(0, false);
  film.timer = setInterval(() => {
    const t = performance.now() / 1000 - film.start;
    if (t > dur) return stopFilm();
    let flash = false, swing = 0;
    for (const ev of film.events) {
      const dt = t - ev.eventTime;
      if (dt >= 0 && dt < 0.45) {
        swing = Math.max(swing, Math.abs(Math.cos(dt * 14)) * (1 - dt / 0.45));
        if (dt < 0.08) flash = true;
      }
    }
    drawDoor(swing, flash);
  }, 40);
}
function stopFilm() {
  if (film.timer) clearInterval(film.timer);
  film.timer = null;
  drawDoor(0, false);
}

// ---------- evaluation panel ----------
async function loadEval() {
  const r = await api('/api/evaluation');
  const row = (name, m) =>
    `<tr><td>${name}</td><td>${m.top1}</td><td>${m.top3}</td><td>${m.top5}</td><td>${m.mrr}</td></tr>`;
  const g = r.gainExperiment;
  $('evalBody').innerHTML = `
  <p><b>分组留一交叉验证（候选池排除查询同源 group）</b></p>
  <table class="metrics">
    <tr><th>索引模式</th><th>Top-1</th><th>Top-3</th><th>Top-5</th><th>MRR</th></tr>
    ${row('等响度 · 道具身份', r.generalTarget.equalized.propIdentity)}
    ${row('等响度 · 动作力度', r.generalTarget.equalized.actionForce)}
    ${row('原动态+响度 · 道具身份', r.generalTarget.dynamicsPreserved.propIdentity)}
    ${row('原动态+响度 · 动作力度', r.generalTarget.dynamicsPreserved.actionForce)}
    ${row('原动态·纯音色(响度块关)', r.generalTarget.dynamicsPreservedTimbreOnly.propIdentity)}
  </table>
  <p><b>增益隔离实验</b>：Top-5 增益纯度（0.5=增益被忽略）
  等响度 ${JSON.stringify(g.gainPurityTop5.equalized)}；
  原动态 ${JSON.stringify(g.gainPurityTop5.dynamicsPreserved)}</p>
  <p>同源孪生平均名次：等响度 ${JSON.stringify(g.sameSourceTwinMeanRank.equalized)}；
  原动态 ${JSON.stringify(g.sameSourceTwinMeanRank.dynamicsPreserved)}</p>
  <p><b>留出道具/击打首候选核对</b>：
  ${r.heldoutCheck.map((h) => `${h.query} 道具<span class="${h.propOk ? 'ok' : 'no'}">${h.propOk ? '✓' : '✗'}</span>
   力度<span class="${h.forceOk ? 'ok' : 'no'}">${h.forceOk ? '✓' : '✗'}</span>`).join(' ｜ ')}</p>
  <p><b>对照片</b>：${r.controls.map((c) =>
    `<span class="mono">${c.query}</span>→同道具名次 ${c.samePropRank}，首候选 <span class="mono">${c.top5[0].id}</span>`).join('；')}</p>
  <p class="hint">音高对照 same-prop Top1=${r.controlSummary.control_pitch.samePropTop1}；
  发声方式对照 same-prop Top1=${r.controlSummary.control_excitation.samePropTop1}
  （平均同道具名次 ${r.controlSummary.control_excitation.meanSamePropRank}）。</p>
  <p class="hint">${r.definition.caveat}</p>`;
}

// ---------- acceptance panel ----------
const KIND_CN = {
  segment: '同源裁片', rerecord: '重录', hardneg_positive: '困难负例·正',
  hardneg_negative: '困难负例·反', invalid: '无效输入', duplicate: '重复文件',
};

function renderAcceptDecision(decision, report) {
  const m = report ? report.metrics : decision.metrics;
  const head = decision.decision === 'published'
    ? '<p><b class="ok">已发布</b> — 当前索引版本通过验收，已写入 data/accept/published/。</p>'
    : '<p><b class="no">已拒绝</b> — 当前索引版本未通过验收，发布目录已清除。</p>';
  const metrics = m ? `
    <table class="metrics">
      <tr><th>证据</th><th>通过</th><th>总数</th></tr>
      <tr><td>同源裁片查重</td><td>${m.dedup.pass}</td><td>${m.dedup.n}</td></tr>
      <tr><td>未见演奏者重录（首位命中率 ${m.generalization.top1}）</td>
          <td>${m.generalization.pass}</td><td>${m.generalization.n}</td></tr>
      <tr><td>困难负例</td><td>${m.hardNegative.pass}</td><td>${m.hardNegative.n}</td></tr>
      <tr><td>无效输入拒绝</td><td>${m.invalid.rejected}</td><td>${m.invalid.n}</td></tr>
      <tr><td>重复文件检出</td><td colspan="2">${m.duplicates.detected}</td></tr>
    </table>` : '';
  const reasons = (decision.reasons || []).length
    ? `<p><b>未通过原因：</b></p><ul class="findings">${decision.reasons.map((r) => `<li>${r}</li>`).join('')}</ul>`
    : '';
  const swap = report && report.loudnessSwap && report.loudnessSwap.firstReversedClass
    ? `<p class="hint">响度统计错换诊断：${report.loudnessSwap.firstReversedClass} 类排序首先反转
       （独立响度分析预期：${report.loudnessSwap.independentExpectation.victim ?? '无'}）。</p>`
    : '';
  $('acceptBody').innerHTML = head + metrics + reasons + swap;
}

async function runAcceptance() {
  $('acceptRunBtn').disabled = true;
  $('acceptStatus').textContent = '验收运行中（重建查询集并逐项核对，约需数秒）…';
  try {
    const { report, decision } = await api('/api/accept/run', {});
    renderAcceptDecision(decision, report);
    $('acceptStatus').textContent = `完成于 ${new Date(report.generatedAt).toLocaleTimeString()}`;
  } catch (e) {
    $('acceptBody').innerHTML = `<p><b class="no">验收异常</b>：${e.message}</p>`;
    $('acceptStatus').textContent = '失败';
  } finally {
    $('acceptRunBtn').disabled = false;
  }
}

async function loadAcceptState() {
  const s = await api('/api/accept/state');
  state.acceptQueries = s.queries;
  state.acceptQueryIds = new Set(s.queries.map((q) => q.id));
  if (s.lastDecision) {
    renderAcceptDecision(s.lastDecision, null);
    $('acceptStatus').textContent = `上次验收：${s.lastDecision.decision === 'published' ? '已发布' : '已拒绝'}（${new Date(s.lastDecision.at).toLocaleString()}）`;
  }
  return s;
}

// ---------- wiring ----------
async function init() {
  const s = await api('/api/state');
  state.clips = s.clips;
  try {
    await loadAcceptState();
  } catch (e) {
    $('acceptBody').textContent = '验收查询集不可用：' + e.message + '（可点击“运行验收”重建）';
  }
  const mainGroup = `<optgroup label="索引剪辑">${s.clips
    .map((c) => `<option value="${c.id}">${c.id}</option>`).join('')}</optgroup>`;
  const acceptGroup = state.acceptQueries.length
    ? `<optgroup label="验收回归样例（索引外查询）">${state.acceptQueries
      .map((q) => `<option value="${q.id}">${q.id}（${KIND_CN[q.kind] || q.kind}）</option>`).join('')}</optgroup>`
    : '';
  $('querySelect').innerHTML = mainGroup + acceptGroup;
  $('querySelect').addEventListener('change', () => showAnalysis($('querySelect').value));
  $('modeSelect').addEventListener('change', () => showAnalysis($('querySelect').value));
  $('searchBtn').addEventListener('click', () => runSearch(false));
  $('resetBtn').addEventListener('click', () => { state.marks.clear(); runSearch(false); });
  $('feedbackBtn').addEventListener('click', () => {
    if (state.acceptQueryIds.has($('querySelect').value)) {
      $('modeHint').textContent = '验收回归样例在索引之外，反馈重排仅适用于索引内查询。';
      return;
    }
    runSearch(true);
  });
  $('importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const r = await fetch('/api/import', { method: 'POST', body: file });
    if (!r.ok) return alert('导入失败：' + (await r.json()).error);
    const out = await r.json();
    const opt = document.createElement('option');
    opt.value = out.id; opt.textContent = `${out.id}（自制导入, RMS ${out.rmsDb}dB）`;
    $('querySelect').appendChild(opt);
    $('querySelect').value = out.id;
    state.clips.push({ id: out.id, group: out.id, kind: 'user', gainTag: 'flat' });
    await showAnalysis(out.id);
    await runSearch(false);
  });
  $('replaceBtn').addEventListener('click', () =>
    buildReplacementTrack().then(() => {}).catch((e) => alert(e.message)));
  $('acceptRunBtn').addEventListener('click', runAcceptance);
  $('playFilmBtn').addEventListener('click', playFilm);
  $('stopFilmBtn').addEventListener('click', () => { stopFilm(); $('replaceAudio').pause(); });
  drawDoor(0, false);
  await showAnalysis($('querySelect').value);
  await runSearch(false);
  await loadEval();
}
init().catch((e) => { $('evalBody').textContent = '初始化失败：' + e.message; console.error(e); });
