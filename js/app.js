import { SLOTS, SLOT_LABEL, computeProject, checkTotal, fmt } from './engine.js';
import { readMany, registerToSlot, DEFAULT_MODEL } from './ocr.js';
import * as store from './store.js';
import { buildAll } from './export.js';
import { zipFiles } from './zip.js';

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLOT_OPTS = [...SLOTS.map((s) => [s, SLOT_LABEL[s]]), ['total', 'Tổng (để kiểm tra)'], ['skip', 'Bỏ qua']];

function defaultPeriod() {
  const d = new Date();
  // Chốt vào cuối tháng hoặc đầu tháng sau: từ ngày 1-15 mặc định là tháng trước.
  const m = d.getDate() <= 15 ? d.getMonth() : d.getMonth() + 1;
  return m === 0 ? { year: d.getFullYear() - 1, month: 12 } : { year: d.getFullYear(), month: m };
}

const state = {
  tab: 'chot',
  period: defaultPeriod(),
  rows: [],          // mỗi chỉ số đọc được từ ảnh
  progress: null,    // {done, total}
  ends: {},          // `${pid}/${mid}` -> {normal, peak, low, total}
  starts: {},        // ghi đè đầu kỳ do anh sửa tay
  manual: {},        // pid -> {reactive, roofBalance}
  exported: null,    // kết quả lần xuất file gần nhất {key, files, issues, notes}
  busy: false,
};

let rowSeq = 0;
const periodKey = () => store.monthKey(state.period.year, state.period.month);
const mkey = (pid, mid) => `${pid}/${mid}`;

// ---------- Dữ liệu dẫn xuất ----------

// Dự án chỉ dùng để xuất hóa đơn (nhập số giờ tay) không có công tơ trong app.
const workProjects = (cfg) => cfg.projects.filter((p) => !p.invoiceOnly);

function allMeters(cfg) {
  return workProjects(cfg).flatMap((p) => p.meters.map((m) => ({ p, m, key: mkey(p.id, m.id) })));
}

function normSerial(s) {
  return String(s ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function autoAssign(cfg, serial, register) {
  const slot = registerToSlot(register);
  const hit = allMeters(cfg).find(({ m }) => m.serial && normSerial(m.serial) === normSerial(serial) && normSerial(serial));
  return { key: hit?.key ?? '', slot: slot ?? 'skip' };
}

function parsePhotoMonth(text) {
  if (!text) return null;
  let m = String(text).match(/(\d{1,2})\s*[Tt]háng\s*(\d{1,2})\s*,?\s*(\d{4})/);
  if (m) return { month: +m[2], year: +m[3] };
  m = String(text).match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) return { month: +m[2], year: +m[3] };
  m = String(text).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? { month: +m[2], year: +m[1] } : null;
}

function rebuildEnds() {
  const dup = {};
  for (const r of state.rows) {
    r.dup = false;
    if (!r.assign?.key || r.assign.slot === 'skip' || typeof r.value !== 'number') continue;
    const k = `${r.assign.key}|${r.assign.slot}`;
    if (k in dup && dup[k] !== r.value) {
      r.dup = true;
      state.rows.find((x) => `${x.assign?.key}|${x.assign?.slot}` === k).dup = true;
    }
    dup[k] = r.value;
    state.ends[r.assign.key] = { ...(state.ends[r.assign.key] || {}), [r.assign.slot]: r.value };
  }
}

function gatherLedger(cfg, p, meter) {
  const key = mkey(p.id, meter.id);
  const start = { ...store.startFor(p, meter, periodKey()).value, ...(state.starts[key] || {}) };
  const end = { ...(state.ends[key] || {}) };
  return { key, start, end, startFrom: store.startFor(p, meter, periodKey()).from };
}

function computeAll(cfg) {
  return workProjects(cfg).map((p) => {
    const manual = state.manual[p.id] || {};
    const readings = {};
    const missing = [];
    const checks = [];
    const ledgers = [];
    for (const meter of p.meters) {
      const L = gatherLedger(cfg, p, meter);
      ledgers.push({ meter, ...L });
      const end = { ...L.end };
      if (p.lowZero && (end.low === undefined || end.low === '')) end.low = L.start.low ?? 0;
      for (const s of SLOTS) {
        if (end[s] === undefined || end[s] === '' || end[s] === null) missing.push(`${meter.label || meter.id}: ${SLOT_LABEL[s].toLowerCase()}`);
        if (L.start[s] === undefined || L.start[s] === '') missing.push(`${meter.label || meter.id}: đầu kỳ ${SLOT_LABEL[s].toLowerCase()}`);
      }
      readings[meter.id] = { start: L.start, end };
      if (L.end.total !== undefined && L.end.total !== '') {
        const c = checkTotal(end, L.end.total);
        checks.push({ meter, ...c });
      }
    }
    let roofBalance = manual.roofBalance;
    if (p.roof && (roofBalance === undefined || roofBalance === '')) roofBalance = lastRoofBalance(p);
    const prices = p.prices || {};
    let result = null;
    if (!missing.length) {
      result = computeProject(p, cfg.company, {
        readings, prices, roofBalance: Number(roofBalance), reactive: Number(manual.reactive),
      });
    }
    return { p, ledgers, missing: [...new Set(missing)], checks, result, roofBalance };
  });
}

function lastRoofBalance(p) {
  const hist = store.history.get();
  const months = Object.keys(hist).filter((k) => k < periodKey()).sort().reverse();
  for (const k of months) {
    const b = hist[k]?.[p.id]?.roofBalanceAfter;
    if (b !== undefined) return b;
  }
  return p.roof?.seedBalance ?? '';
}

// ---------- Hiển thị ----------

function render() {
  const cfg = store.config.get();
  const tabs = [['chot', 'Chốt tháng'], ['xuat', 'Xuất file'], ['lichsu', 'Lịch sử'], ['caidat', 'Cài đặt']];
  $app.innerHTML = `
    <header class="top"><h1>Ecoshine · Chốt số</h1></header>
    <main>${state.tab === 'chot' ? viewChot(cfg) : state.tab === 'xuat' ? viewExport(cfg) : state.tab === 'lichsu' ? viewHistory(cfg) : viewSettings(cfg)}</main>
    <nav class="tabs">${tabs.map(([id, label]) => `<button data-act="tab" data-tab="${id}" class="${state.tab === id ? 'on' : ''}">${label}</button>`).join('')}</nav>
    <div id="toast" class="toast" hidden></div>`;
  if (state.tab === 'chot') renderResults();
}

function viewChot(cfg) {
  if (!workProjects(cfg).length) {
    return `<section class="card"><h2>Chưa có dự án</h2><p>Vào <b>Cài đặt</b> để nhập cấu hình (file .json anh đã có) và khóa API.</p></section>`;
  }
  return `
    <section class="card">
      ${periodPicker()}
      <label class="drop" id="drop">
        <input type="file" accept="image/*" multiple hidden data-act="files">
        <b>Chọn nhiều ảnh một lần</b>
        <span>Ảnh công tơ hoặc ảnh chụp màn hình. Trên máy tính có thể kéo thả hoặc dán (Ctrl+V).</span>
      </label>
      ${state.progress ? `<p class="progress">Đang đọc ${state.progress.done}/${state.progress.total} ảnh…</p>` : ''}
    </section>
    ${state.rows.length ? `<section class="card"><h2>Chỉ số đọc từ ảnh</h2><div id="rows">${state.rows.map((r) => rowCard(cfg, r)).join('')}</div></section>` : ''}
    <div id="results"></div>`;
}

function periodPicker() {
  const months = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${state.period.month === i + 1 ? 'selected' : ''}>Tháng ${i + 1}</option>`).join('');
  return `<div class="period"><label>Kỳ chốt
    <span><select data-act="month">${months}</select>
    <input type="number" data-act="year" value="${state.period.year}" min="2025" max="2100"></span></label></div>`;
}

function rowCard(cfg, r) {
  const meters = allMeters(cfg);
  const pm = parsePhotoMonth(r.photoTime);
  const stale = pm && (pm.month !== state.period.month || pm.year !== state.period.year);
  const flags = [
    r.confidence && r.confidence !== 'high' ? `<span class="flag warn">Độ tin cậy ${r.confidence === 'medium' ? 'vừa' : 'thấp'}</span>` : '',
    r.dup ? '<span class="flag bad">Trùng ô, hai số khác nhau</span>' : '',
    stale ? `<span class="flag warn">Ảnh chụp ${esc(r.photoTime)}, khác kỳ chốt</span>` : '',
    r.error ? `<span class="flag bad">${esc(r.error)}</span>` : '',
  ].join('');
  return `
    <div class="rowcard" data-row="${r.id}">
      ${r.thumb ? `<img src="${r.thumb}" alt="">` : '<div class="noimg">!</div>'}
      <div class="rc-body">
        <div class="rc-line"><span class="muted">${esc(r.name)}</span> ${r.serial ? `<span class="chip">sx ${esc(r.serial)}</span>` : ''} ${r.register ? `<span class="chip">${esc(r.register)}</span>` : ''}</div>
        ${r.error ? '' : `<div class="rc-edit">
          <input type="number" step="any" inputmode="decimal" data-act="rowvalue" value="${r.value ?? ''}" placeholder="chưa đọc được">
          <select data-act="rowkey"><option value="">— công tơ —</option>${meters.map(({ p, m, key }) => `<option value="${esc(key)}" ${r.assign?.key === key ? 'selected' : ''}>${esc(p.name)} · ${esc(m.label || m.id)}</option>`).join('')}</select>
          <select data-act="rowslot">${SLOT_OPTS.map(([v, l]) => `<option value="${v}" ${r.assign?.slot === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>`}
        ${flags ? `<div class="flags">${flags}</div>` : ''}
        ${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ''}
      </div>
      <button class="x" data-act="rowdel" aria-label="Xóa">×</button>
    </div>`;
}

function renderResults() {
  const el = document.getElementById('results');
  if (!el) return;
  const cfg = store.config.get();
  el.innerHTML = computeAll(cfg).map((c) => projectCard(cfg, c)).join('');
}

function numInput(attrs, value, ph = '') {
  return `<input type="number" step="any" inputmode="decimal" ${attrs} value="${value ?? ''}" placeholder="${ph}">`;
}

function projectCard(cfg, c) {
  const { p, ledgers, missing, checks, result } = c;
  const manual = state.manual[p.id] || {};
  const meterRows = ledgers.map((L) => `
    <div class="meter"><h4>${esc(L.meter.label || L.meter.id)}${L.startFrom ? `<small> · đầu kỳ lấy từ T${esc(L.startFrom.slice(5))}/${esc(L.startFrom.slice(0, 4))}</small>` : '<small> · đầu kỳ khởi tạo</small>'}</h4>
      <table class="ledger"><thead><tr><th></th><th>Đầu kỳ</th><th>Cuối kỳ</th></tr></thead><tbody>
      ${SLOTS.map((s) => `<tr><td>${SLOT_LABEL[s]}</td>
        <td>${numInput(`data-act="start" data-k="${esc(L.key)}" data-s="${s}"`, L.start[s])}</td>
        <td>${numInput(`data-act="end" data-k="${esc(L.key)}" data-s="${s}"`, L.end[s], p.lowZero && s === 'low' ? '0' : '')}</td></tr>`).join('')}
      <tr><td class="muted">Tổng (kiểm tra)</td><td></td><td>${numInput(`data-act="end" data-k="${esc(L.key)}" data-s="total"`, L.end.total)}</td></tr>
      </tbody></table></div>`).join('');

  const extras = [
    p.roof ? `<label>Số dư mái tôn còn lại ${numInput(`data-act="manual" data-p="${esc(p.id)}" data-f="roofBalance"`, c.roofBalance)}</label>` : '',
    p.reactive ? `<label>Khấu trừ phản kháng (đồng) ${numInput(`data-act="manual" data-p="${esc(p.id)}" data-f="reactive"`, manual.reactive, '0')}</label>` : '',
  ].join('');

  const priceRow = `<div class="prices">${SLOTS.map((s) => `<label>${SLOT_LABEL[s]} (đ/kWh) ${numInput(`data-act="price" data-p="${esc(p.id)}" data-s="${s}"`, p.prices?.[s])}</label>`).join('')}</div>`;

  const checkTxt = checks.map((k) => `<div class="flag ${k.ok ? 'ok' : 'bad'}">${esc(k.meter.label || k.meter.id)}: ${k.ok ? 'tổng ba khung khớp tổng công tơ' : `ba khung cộng lại lệch ${fmt.n2(k.diff)} kWh so với tổng, có thể đọc nhầm số`}</div>`).join('');

  let out = '';
  if (missing.length) {
    out = `<div class="flag warn">Chưa đủ số: ${esc(missing.join('; '))}</div>`;
  } else if (result) {
    out = `
      <div class="big"><span>Số giờ thuê</span><b>${fmt.n1(result.hours)}</b><span>giờ</span></div>
      <div class="inv"><div><span>Trước VAT</span><b>${fmt.vnd(result.invoice.before)}</b></div><div><span>VAT</span><b>${fmt.vnd(result.invoice.vat)}</b></div><div><span>Sau VAT</span><b>${fmt.vnd(result.invoice.after)}</b></div></div>
      ${result.warnings.map((w) => `<div class="flag bad">${esc(w)}</div>`).join('')}
      <details class="internal"><summary>Chi tiết nội bộ (không gửi khách)</summary>
        <table class="ledger"><tbody>
          ${SLOTS.map((s) => `<tr><td>${SLOT_LABEL[s]}</td><td class="r">${fmt.int(result.kwh[s])} kWh</td><td class="r">${fmt.vnd(result.money[s])}</td></tr>`).join('')}
          <tr><td>Tiền điện theo giá EVN</td><td></td><td class="r">${fmt.vnd(result.total)}</td></tr>
          <tr><td>Sau chiết khấu (${Math.round(p.discount * 100)}%)</td><td></td><td class="r">${fmt.vnd(result.use)}</td></tr>
          <tr><td>Tiền tiết kiệm của khách</td><td></td><td class="r">${fmt.vnd(result.saving)}</td></tr>
          ${p.roof ? `<tr><td>Khấu trừ mái tôn</td><td></td><td class="r">${fmt.vnd(result.adjustments.roof)}</td></tr>` : ''}
          ${p.reactive ? `<tr><td>Khấu trừ phản kháng</td><td></td><td class="r">${fmt.vnd(result.adjustments.reactive)}</td></tr>` : ''}
          <tr><td>Số giờ chưa làm tròn</td><td></td><td class="r">${result.hoursRaw.toFixed(4)}</td></tr>
        </tbody></table></details>
      <button class="primary" data-act="close" data-p="${esc(p.id)}">Chốt tháng ${state.period.month}/${state.period.year} cho ${esc(p.name)}</button>`;
  }

  return `<section class="card proj"><h2>${esc(p.name)}</h2>
    ${meterRows}${priceRow}${extras ? `<div class="extras">${extras}</div>` : ''}${checkTxt}${out}</section>`;
}

function viewHistory(cfg) {
  const hist = store.history.get();
  const keys = Object.keys(hist).sort().reverse();
  const list = keys.length ? keys.map((k) => `
    <div class="hrow"><b>T${esc(k)}</b>
      ${Object.entries(hist[k]).map(([pid, v]) => `<span class="chip">${esc(cfg.projects.find((p) => p.id === pid)?.name || pid)}: ${fmt.n1(v.hours)} giờ${v.manual ? ' (nhập tay)' : ''}</span>`).join('')}
      <button class="x" data-act="histdel" data-k="${esc(k)}" aria-label="Xóa">×</button></div>`).join('') : '<p class="muted">Chưa chốt tháng nào trong app này.</p>';
  return `<section class="card"><h2>Các tháng đã chốt</h2>${list}</section>
    <section class="card"><h2>Sao lưu</h2>
      <button data-act="export">Tải bản sao lưu (.json)</button>
      <label class="btn">Nạp bản sao lưu <input type="file" accept=".json" hidden data-act="import"></label>
      <p class="muted small">Bản sao lưu chứa cấu hình và lịch sử, giữ ở nơi riêng tư. Khóa API không nằm trong đó.</p></section>`;
}

const KIND_LABEL = { client: 'Gửi khách', summary: 'Gửi kế toán', internal: 'Nội bộ, có kWh' };
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function viewExport(cfg) {
  const key = periodKey();
  const month = store.history.get()[key] || {};
  const rows = cfg.projects.map((p) => {
    const rec = month[p.id];
    let status;
    if (p.invoiceOnly) {
      status = `<input type="number" step="any" inputmode="decimal" data-act="manualhours" data-p="${esc(p.id)}" value="${rec?.hours ?? ''}" placeholder="số giờ">`;
    } else {
      status = rec ? `<b>${fmt.n1(rec.hours)} giờ</b>` : '<span class="muted">chưa chốt kỳ này</span>';
    }
    return `<tr><td>${esc(p.name)}</td><td class="r">${status}</td></tr>`;
  }).join('');
  const ex = state.exported?.key === key ? state.exported : null;
  const blocked = ex?.issues.length > 0;
  const fileList = ex && !blocked ? `
    <h2>File đã tạo</h2>
    ${ex.files.map((f, i) => `<div class="frow"><div><b>${esc(f.name)}</b><br><span class="chip ${f.kind === 'internal' ? 'chip-int' : ''}">${KIND_LABEL[f.kind]}</span></div>
      <button data-act="dlfile" data-i="${i}">Tải</button></div>`).join('')}
    <button class="primary" data-act="dlzip">Tải tất cả (.zip)</button>
    ${navigator.canShare ? '<button data-act="share">Chia sẻ file gửi khách và kế toán</button>' : ''}
    <div class="flag ok">Đã soát: file gửi khách và kế toán không có kWh, giá EVN, chiết khấu.</div>` : '';
  return `
    <section class="card"><h2>Xuất file chốt tháng</h2>
      ${periodPicker()}
      <table class="ledger"><tbody>${rows}</tbody></table>
      <button class="primary" data-act="gen" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Đang tạo…' : 'Tạo bộ file'}</button>
      <p class="muted small">Ngày ký tự lấy ngày cuối tháng. File nội bộ có kWh nằm riêng, không bao giờ chung với file gửi khách.</p>
    </section>
    ${ex ? `<section class="card">
      ${ex.issues.map((m) => `<div class="flag bad">${esc(m)}</div>`).join('')}
      ${blocked ? '<div class="flag bad">Có lỗi nên em chặn không cho tải. Anh báo lại để em sửa.</div>' : ''}
      ${ex.notes.map((m) => `<div class="flag warn">${esc(m)}</div>`).join('')}
      ${fileList}</section>` : ''}`;
}

function saveBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function generate() {
  const cfg = store.config.get();
  state.busy = true;
  state.exported = null;
  render();
  try {
    const out = await buildAll(cfg, state.period, store.history.get(), store.settings.get());
    state.exported = { key: periodKey(), ...out };
    if (!out.files.length) toast('Chưa có dự án nào chốt trong kỳ này');
  } catch (err) {
    state.exported = { key: periodKey(), files: [], issues: [`Lỗi khi tạo file: ${err.message}`], notes: [] };
  }
  state.busy = false;
  render();
}

function viewSettings(cfg) {
  const s = store.settings.get();
  return `
    <section class="card"><h2>Khóa AI đọc ảnh</h2>
      <label>Khóa API Anthropic <input type="password" data-act="apikey" value="${esc(s.apiKey)}" autocomplete="off" placeholder="sk-ant-..."></label>
      <label>Mô hình <input type="text" data-act="model" value="${esc(s.model)}" placeholder="${DEFAULT_MODEL}"></label>
      <p class="muted small">Khóa chỉ lưu trong trình duyệt của thiết bị này. Nhớ đặt hạn mức chi tiêu thấp cho khóa trên trang quản lý của Anthropic.</p></section>
    <section class="card"><h2>Thông tin nhận tiền</h2>
      <label>Số tài khoản nhận tiền (in vào Giấy đề nghị thanh toán) <input type="text" inputmode="numeric" data-act="bankaccount" value="${esc(s.bankAccount)}" autocomplete="off"></label>
      <p class="muted small">Chỉ lưu trong trình duyệt của thiết bị này, không nằm trong cấu hình hay bản sao lưu.</p></section>
    <section class="card"><h2>Cấu hình dự án</h2>
      <label class="btn">Nạp file cấu hình (.json) <input type="file" accept=".json" hidden data-act="import"></label>
      <details><summary>Sửa trực tiếp (nâng cao)</summary>
        <textarea id="cfgtext" rows="14" spellcheck="false">${esc(JSON.stringify(cfg, null, 2))}</textarea>
        <button data-act="savecfg">Lưu cấu hình</button></details>
      <p class="muted small">Hiện có ${cfg.projects.length} dự án: ${esc(cfg.projects.map((p) => p.name).join(', ') || 'chưa có')}.</p></section>`;
}

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- Đọc ảnh ----------

async function handleFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length) return;
  const { apiKey, model } = store.settings.get();
  if (!apiKey) {
    toast('Chưa có khóa API. Vào Cài đặt nhập khóa trước.');
    return;
  }
  const cfg = store.config.get();
  state.progress = { done: 0, total: files.length };
  render();
  const results = await readMany(files, {
    apiKey, model: model || DEFAULT_MODEL,
    onProgress: (i, st) => {
      if (st === 'done' || st === 'error') {
        state.progress.done += 1;
        const el = document.querySelector('.progress');
        if (el) el.textContent = `Đang đọc ${state.progress.done}/${state.progress.total} ảnh…`;
      }
    },
  });
  for (const res of results) {
    if (!res.ok) {
      state.rows.push({ id: ++rowSeq, name: res.name, error: res.error });
      continue;
    }
    const { parsed } = res;
    let added = 0;
    for (const m of parsed.meters || []) {
      for (const rd of m.readings || []) {
        state.rows.push({
          id: ++rowSeq, name: res.name, thumb: res.thumb, serial: m.serial, register: rd.register,
          value: typeof rd.value === 'number' ? rd.value : null, confidence: rd.confidence,
          photoTime: parsed.photo_time, note: parsed.note, assign: autoAssign(cfg, m.serial, rd.register),
        });
        added += 1;
      }
    }
    if (!added) state.rows.push({ id: ++rowSeq, name: res.name, thumb: res.thumb, note: parsed.note || 'Không thấy chỉ số trong ảnh', error: 'Không đọc được chỉ số' });
  }
  state.progress = null;
  rebuildEnds();
  render();
}

// ---------- Sự kiện ----------

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'tab') { state.tab = el.dataset.tab; render(); }
  else if (act === 'rowdel') {
    const id = Number(el.closest('[data-row]').dataset.row);
    state.rows = state.rows.filter((r) => r.id !== id);
    state.ends = {};
    rebuildEnds();
    render();
  } else if (act === 'close') closeMonth(el.dataset.p);
  else if (act === 'histdel') {
    if (!confirm(`Xóa kỳ ${el.dataset.k} khỏi lịch sử?`)) return;
    const h = store.history.get();
    delete h[el.dataset.k];
    store.history.set(h);
    render();
  } else if (act === 'gen') generate();
  else if (act === 'dlfile') {
    const f = state.exported.files[Number(el.dataset.i)];
    saveBlob(f.name, new Blob([f.data], { type: XLSX_MIME }));
  } else if (act === 'dlzip') {
    const folder = { internal: 'Nội bộ - không gửi ngoài', client: 'Gửi khách', summary: 'Gửi kế toán' };
    const key = periodKey();
    saveBlob(`Chốt tháng ${key}.zip`, zipFiles(state.exported.files.map((f) => ({ name: `${folder[f.kind]}/${f.name}`, data: f.data }))));
  } else if (act === 'share') {
    const files = state.exported.files.filter((f) => f.kind !== 'internal').map((f) => new File([f.data], f.name, { type: XLSX_MIME }));
    try {
      if (navigator.canShare?.({ files })) await navigator.share({ files });
      else toast('Thiết bị này không hỗ trợ chia sẻ file, hãy dùng nút Tải');
    } catch (err) { if (err.name !== 'AbortError') toast(`Không chia sẻ được: ${err.message}`); }
  } else if (act === 'export') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([store.exportAll()], { type: 'application/json' }));
    a.download = `ecoshine-sao-luu-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } else if (act === 'savecfg') {
    try {
      store.config.set(JSON.parse(document.getElementById('cfgtext').value));
      toast('Đã lưu cấu hình');
      render();
    } catch (err) { toast(`Cấu hình sai định dạng: ${err.message}`); }
  }
});

$app.addEventListener('change', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'files') { await handleFiles(el.files); el.value = ''; }
  else if (act === 'month') { state.period.month = Number(el.value); state.ends = {}; state.rows = []; state.exported = null; render(); }
  else if (act === 'year') { state.period.year = Number(el.value); state.ends = {}; state.rows = []; state.exported = null; render(); }
  else if (act === 'manualhours') {
    // Dự án chưa có trong app (chỉ xuất hóa đơn): anh gõ số giờ đã chốt, lưu như một kỳ nhập tay.
    const hist = store.history.get();
    const key = periodKey();
    if (el.value === '') { delete hist[key]?.[el.dataset.p]; if (hist[key] && !Object.keys(hist[key]).length) delete hist[key]; }
    else (hist[key] ||= {})[el.dataset.p] = { hours: Number(el.value), manual: true, closedAt: new Date().toISOString() };
    store.history.set(hist);
    state.exported = null;
    render();
  } else if (act === 'bankaccount') {
    const s = store.settings.get();
    s.bankAccount = el.value.trim();
    store.settings.set(s);
    toast('Đã lưu');
  }
  else if (act === 'rowvalue') {
    const r = state.rows.find((x) => x.id === Number(el.closest('[data-row]').dataset.row));
    r.value = el.value === '' ? null : Number(el.value);
    state.ends = {}; rebuildEnds(); render();
  } else if (act === 'rowkey' || act === 'rowslot') {
    const r = state.rows.find((x) => x.id === Number(el.closest('[data-row]').dataset.row));
    r.assign = { ...(r.assign || {}), [act === 'rowkey' ? 'key' : 'slot']: el.value };
    state.ends = {}; rebuildEnds(); render();
  } else if (act === 'apikey' || act === 'model') {
    const s = store.settings.get();
    s[act === 'apikey' ? 'apiKey' : 'model'] = el.value.trim();
    store.settings.set(s);
    toast('Đã lưu');
  } else if (act === 'import') {
    try {
      const r = store.importAll(await el.files[0].text());
      toast(`Đã nạp ${[r.config && 'cấu hình', r.history && 'lịch sử'].filter(Boolean).join(' và ')}`);
      render();
    } catch (err) { toast(`Không nạp được: ${err.message}`); }
  }
});

$app.addEventListener('input', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const v = el.value === '' ? '' : Number(el.value);
  const act = el.dataset.act;
  if (act === 'end') { (state.ends[el.dataset.k] ||= {})[el.dataset.s] = v; renderResults(); refocus(el); }
  else if (act === 'start') { (state.starts[el.dataset.k] ||= {})[el.dataset.s] = v; renderResults(); refocus(el); }
  else if (act === 'manual') { (state.manual[el.dataset.p] ||= {})[el.dataset.f] = v; renderResults(); refocus(el); }
  else if (act === 'price') {
    const cfg = store.config.get();
    const p = cfg.projects.find((x) => x.id === el.dataset.p);
    (p.prices ||= {})[el.dataset.s] = v === '' ? 0 : v;
    store.config.set(cfg);
    renderResults(); refocus(el);
  }
});

// renderResults dựng lại khối kết quả nên con trỏ nhập bị mất; đặt lại đúng ô đang gõ.
function refocus(el) {
  const sel = ['data-act', 'data-k', 'data-s', 'data-p', 'data-f'].filter((a) => el.hasAttribute(a)).map((a) => `[${a}="${CSS.escape(el.getAttribute(a))}"]`).join('');
  const next = document.querySelector(`#results ${sel}`);
  if (next && next !== el) {
    next.focus();
    const n = next.value.length;
    try { next.setSelectionRange(n, n); } catch { /* input number không hỗ trợ */ }
  }
}

document.addEventListener('paste', (e) => {
  if (state.tab !== 'chot') return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); handleFiles(files); }
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  if (state.tab !== 'chot' || !e.dataTransfer?.files?.length) return;
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});

function closeMonth(pid) {
  const cfg = store.config.get();
  const c = computeAll(cfg).find((x) => x.p.id === pid);
  if (!c?.result) return;
  const key = periodKey();
  const hist = store.history.get();
  if (hist[key]?.[pid] && !confirm(`Kỳ ${key} của ${c.p.name} đã chốt rồi. Ghi đè?`)) return;
  const readings = {};
  for (const L of c.ledgers) {
    const end = { normal: L.end.normal, peak: L.end.peak, low: L.end.low ?? L.start.low ?? 0 };
    readings[L.meter.id] = { start: { normal: L.start.normal, peak: L.start.peak, low: L.start.low ?? 0 }, end };
  }
  const roofAfter = c.p.roof ? Math.max(0, Number(c.roofBalance || 0) - c.result.adjustments.roof) : undefined;
  (hist[key] ||= {})[pid] = {
    readings, prices: { ...c.p.prices }, hours: c.result.hours, invoice: c.result.invoice,
    reactive: state.manual[pid]?.reactive || 0, roofBalanceBefore: c.p.roof ? Number(c.roofBalance || 0) : undefined,
    roofBalanceAfter: roofAfter, closedAt: new Date().toISOString(),
  };
  state.exported = null;
  if (!store.history.set(hist)) { toast('Không lưu được vào trình duyệt'); return; }
  toast(`Đã chốt ${c.p.name} kỳ ${key}: ${fmt.n1(c.result.hours)} giờ`);
  renderResults();
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
