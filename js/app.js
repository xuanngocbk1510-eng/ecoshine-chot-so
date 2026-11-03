import { SLOTS, SLOT_LABEL, computeProject, checkTotal, fmt } from './engine.js';
import { readMany, registerToSlot, DEFAULT_MODEL } from './ocr.js';
import * as store from './store.js';
import { buildAll } from './export.js';
import { zipFiles } from './zip.js';
import * as lock from './lock.js';
import { extractCss, checkCss, applyCss, buildBrief } from './theme.js';

const APP_VERSION = '2026-11-03a';
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
  progress: {},      // pid -> {done, total}
  activePid: null,   // dự án anh vừa chạm vào, dùng cho dán ảnh (Ctrl+V)
  ends: {},          // `${pid}/${mid}` -> {normal, peak, low, total}
  manual: {},        // pid -> {reactive, adjust, roofBalance}
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

// Khung giờ hiển thị và tính cho từng dự án: dự án thấp điểm luôn bằng 0 thì bỏ hẳn dòng thấp điểm.
const slotsOf = (p) => (p.lowZero ? SLOTS.filter((s) => s !== 'low') : SLOTS);

// Mỗi dự án có ô nhập riêng nên ảnh chỉ được gán cho công tơ của chính dự án đó.
function autoAssign(cfg, pid, serial, register) {
  const p = cfg.projects.find((x) => x.id === pid);
  let slot = registerToSlot(register) ?? 'skip';
  if (slot === 'low' && p.lowZero) slot = 'skip';
  const sn = normSerial(serial);
  const mine = sn && p.meters.find((m) => normSerial(m.serial) === sn);
  if (mine) return { key: mkey(pid, mine.id), slot };
  const other = sn && allMeters(cfg).find(({ p: op, m }) => op.id !== pid && normSerial(m.serial) === sn);
  if (other) return { key: '', slot, foreign: other.p.name };
  if (p.meters.length === 1) return { key: mkey(pid, p.meters[0].id), slot, serialMismatch: !!sn };
  return { key: '', slot };
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

// Đầu kỳ chỉ lấy từ file Excel tháng trước (chỉ số khởi tạo trong cấu hình) hoặc từ tháng đã chốt gần nhất; không sửa tay ở đây.
function gatherLedger(cfg, p, meter) {
  const key = mkey(p.id, meter.id);
  const st = store.startFor(p, meter, periodKey());
  return { key, start: st.value, end: { ...(state.ends[key] || {}) }, startFrom: st.from };
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
      if (p.lowZero) end.low = L.start.low ?? 0; // thấp điểm bỏ qua: cuối kỳ = đầu kỳ, kWh = 0
      for (const s of SLOTS) {
        if (end[s] === undefined || end[s] === '' || end[s] === null) missing.push(`${meter.label || meter.id}: ${SLOT_LABEL[s].toLowerCase()}`);
        if (L.start[s] === undefined || L.start[s] === '') missing.push(`${meter.label || meter.id}: đầu kỳ ${SLOT_LABEL[s].toLowerCase()}`);
      }
      readings[meter.id] = { start: L.start, end };
      if (L.end.total !== undefined && L.end.total !== '') {
        const c = checkTotal(end, L.end.total, 1.01, !!p.lowZero);
        checks.push({ meter, ...c });
      }
    }
    let roofBalance = manual.roofBalance;
    if (p.roof && (roofBalance === undefined || roofBalance === '')) roofBalance = lastRoofBalance(p);
    // Chưa có số dư mái tôn thì không tính, kẻo thiếu tiền mà không biết.
    if (p.roof && (roofBalance === '' || roofBalance === undefined || Number.isNaN(Number(roofBalance)))) missing.push('số dư mái tôn (anh nhập ở ô Số dư mái tôn)');
    const prices = p.prices || {};
    let result = null;
    if (!missing.length) {
      result = computeProject(p, cfg.company, {
        readings, prices, roofBalance: Number(roofBalance), reactive: Number(manual.reactive), adjust: Number(manual.adjust),
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
  // Mỗi dự án một ổ nhập riêng: ảnh thả vào ổ nào chỉ tính cho dự án đó, không lẫn sang dự án khác.
  return `
    <section class="card">${periodPicker()}</section>
    ${workProjects(cfg).map((p) => {
    const prog = state.progress[p.id];
    const rows = state.rows.filter((r) => r.pid === p.id);
    return `<section class="card proj" data-pid="${esc(p.id)}"><h2>${esc(p.name)}</h2>
      <label class="drop" data-pid="${esc(p.id)}">
        <input type="file" accept="image/*" multiple hidden data-act="files" data-pid="${esc(p.id)}">
        <b>Chọn nhiều ảnh của ${esc(p.name)}</b>
        <span>Ảnh công tơ hoặc ảnh chụp màn hình. Trên máy tính có thể kéo thả vào ô này hoặc bấm vào ô rồi dán (Ctrl+V).</span>
      </label>
      ${prog ? `<p class="progress" data-pid="${esc(p.id)}">Đang đọc ${prog.done}/${prog.total} ảnh…</p>` : ''}
      ${rows.length ? `<div class="rows">${rows.map((r) => rowCard(p, r)).join('')}</div>` : ''}
      <div class="pcalc" data-pid="${esc(p.id)}"></div></section>`;
  }).join('')}`;
}

function periodPicker() {
  const months = Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${state.period.month === i + 1 ? 'selected' : ''}>Tháng ${i + 1}</option>`).join('');
  return `<div class="period"><label>Kỳ chốt
    <span><select data-act="month">${months}</select>
    <input type="number" data-act="year" value="${state.period.year}" min="2025" max="2100"></span></label></div>`;
}

function rowCard(p, r) {
  const slotOpts = SLOT_OPTS.filter(([v]) => v !== 'low' || !p.lowZero);
  const pm = parsePhotoMonth(r.photoTime);
  const stale = pm && (pm.month !== state.period.month || pm.year !== state.period.year);
  const flags = [
    r.confidence && r.confidence !== 'high' ? `<span class="flag warn">Độ tin cậy ${r.confidence === 'medium' ? 'vừa' : 'thấp'}</span>` : '',
    r.dup ? '<span class="flag bad">Trùng ô, hai số khác nhau</span>' : '',
    r.assign?.foreign ? `<span class="flag bad">Số seri này là công tơ của ${esc(r.assign.foreign)}. Anh bỏ nhầm ô? Em chưa gán ảnh này.</span>` : '',
    r.assign?.serialMismatch ? `<span class="flag warn">Số seri đọc được (${esc(r.serial)}) không khớp công tơ đã cấu hình, em gán vào công tơ duy nhất của dự án. Anh kiểm tra lại.</span>` : '',
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
          <select data-act="rowkey"><option value="">— công tơ —</option>${p.meters.map((m) => { const key = mkey(p.id, m.id); return `<option value="${esc(key)}" ${r.assign?.key === key ? 'selected' : ''}>${esc(m.label || m.id)}</option>`; }).join('')}</select>
          <select data-act="rowslot">${slotOpts.map(([v, l]) => `<option value="${v}" ${r.assign?.slot === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </div>`}
        ${flags ? `<div class="flags">${flags}</div>` : ''}
        ${r.note ? `<div class="muted small">${esc(r.note)}</div>` : ''}
      </div>
      <button class="x" data-act="rowdel" aria-label="Xóa">×</button>
    </div>`;
}

function renderResults() {
  const cfg = store.config.get();
  for (const c of computeAll(cfg)) {
    const el = document.querySelector(`.pcalc[data-pid="${CSS.escape(c.p.id)}"]`);
    if (el) el.innerHTML = projectCard(cfg, c);
  }
}

// Ô nhập: số tiền, đơn giá... chỉ sửa được khi đã mở khóa bằng PIN (data-lock = chạm vào để mở khóa).
function numInput(attrs, value, ph = '', gated = false) {
  const lockAttr = gated && !lock.canEdit() ? ' readonly data-lock' : '';
  return `<input type="number" step="any" inputmode="decimal" ${attrs}${lockAttr} value="${value ?? ''}" placeholder="${ph}">`;
}

const showNum = (v) => (v === undefined || v === '' || v === null ? '—' : Number(v).toLocaleString('vi-VN', { maximumFractionDigits: 2 }));

function lockBar() {
  if (!lock.hasPin()) return '<p class="lockbar warn">Chưa đặt mã PIN (vào Cài đặt). Hiện ai cầm thiết bị này cũng sửa được đơn giá.</p>';
  return lock.canEdit() ? '<p class="lockbar">Đã mở khóa. Đơn giá và các khoản điều chỉnh sửa được, tự khóa lại sau 10 phút.</p>'
    : '<p class="lockbar">Đơn giá và các khoản điều chỉnh đang khóa. Chạm vào ô để nhập PIN mở khóa.</p>';
}

function projectCard(cfg, c) {
  const { p, ledgers, missing, checks, result } = c;
  const manual = state.manual[p.id] || {};
  const meterRows = ledgers.map((L) => `
    <div class="meter"><h4>${esc(L.meter.label || L.meter.id)}${L.startFrom ? `<small> · đầu kỳ lấy từ T${esc(L.startFrom.slice(5))}/${esc(L.startFrom.slice(0, 4))}, không sửa</small>` : '<small> · đầu kỳ lấy từ file Excel tháng trước, không sửa</small>'}</h4>
      <table class="ledger"><thead><tr><th></th><th class="r">Đầu kỳ</th><th>Cuối kỳ</th></tr></thead><tbody>
      ${slotsOf(p).map((s) => `<tr><td>${SLOT_LABEL[s]}</td>
        <td class="start">${showNum(L.start[s])}</td>
        <td>${numInput(`data-act="end" data-k="${esc(L.key)}" data-s="${s}"`, L.end[s])}</td></tr>`).join('')}
      <tr><td class="muted">Tổng (kiểm tra)</td><td></td><td>${numInput(`data-act="end" data-k="${esc(L.key)}" data-s="total"`, L.end.total)}</td></tr>
      </tbody></table></div>`).join('');

  const ctl = (f, v, ph) => numInput(`data-act="manual" data-p="${esc(p.id)}" data-f="${f}"`, v, ph, true);
  const extras = [
    p.roof ? `<label>Số dư mái tôn Ecoshine còn phải thu hồi (đồng) ${ctl('roofBalance', c.roofBalance)}</label>` : '',
    p.adjust ? `<label>${esc(p.adjust.label || 'Bù trừ kỳ trước')} (đồng, số âm là giảm) ${ctl('adjust', manual.adjust, '0')}</label>` : '',
    p.reactive ? `<label>Khấu trừ phản kháng (đồng, nhập số dương) ${ctl('reactive', manual.reactive, '0')}</label>` : '',
  ].join('');

  const priceRow = `<div class="prices">${slotsOf(p).map((s) => `<label>${SLOT_LABEL[s]} (đ/kWh) ${numInput(`data-act="price" data-p="${esc(p.id)}" data-s="${s}"`, p.prices?.[s], '', true)}</label>`).join('')}</div>${lockBar()}`;

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
          ${slotsOf(p).map((s) => `<tr><td>${SLOT_LABEL[s]}</td><td class="r">${fmt.int(result.kwh[s])} kWh</td><td class="r">${fmt.vnd(result.money[s])}</td></tr>`).join('')}
          <tr><td>Tiền điện theo giá EVN</td><td></td><td class="r">${fmt.vnd(result.total)}</td></tr>
          <tr><td>Sau chiết khấu (${Math.round(p.discount * 100)}%)</td><td></td><td class="r">${fmt.vnd(result.use)}</td></tr>
          <tr><td>Tiền tiết kiệm của khách</td><td></td><td class="r">${fmt.vnd(result.saving)}</td></tr>
          ${p.roof ? `<tr><td>Thu hồi chi phí mái tôn (cộng)</td><td></td><td class="r">${fmt.vnd(result.adjustments.roof)}</td></tr>` : ''}
          ${p.adjust ? `<tr><td>Bù trừ kỳ trước</td><td></td><td class="r">${fmt.vnd(result.adjustments.adjust)}</td></tr>` : ''}
          ${p.reactive ? `<tr><td>Khấu trừ phản kháng (trừ)</td><td></td><td class="r">${fmt.vnd(result.adjustments.reactive)}</td></tr>` : ''}
          <tr><td>Số giờ chưa làm tròn</td><td></td><td class="r">${result.hoursRaw.toFixed(4)}</td></tr>
        </tbody></table></details>
      <button class="primary" data-act="close" data-p="${esc(p.id)}">Chốt tháng ${state.period.month}/${state.period.year} cho ${esc(p.name)}</button>`;
  }

  return `${meterRows}${priceRow}${extras ? `<div class="extras">${extras}</div>` : ''}${checkTxt}${out}`;
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
      <button data-act="pickimport">Nạp bản sao lưu (cần PIN)</button><input type="file" accept=".json" hidden id="importfile" data-act="import">
      <p class="muted small">Bản sao lưu chứa cấu hình và lịch sử, giữ ở nơi riêng tư. Khóa API và mã PIN không nằm trong đó.</p></section>`;
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
      <label>Khóa API Gemini <input type="password" data-act="apikey" value="${esc(s.apiKey)}" autocomplete="off" placeholder="AIza..."></label>
      <label>Mô hình <input type="text" data-act="model" value="${esc(s.model)}" placeholder="${DEFAULT_MODEL}"></label>
      <p class="muted small">Khóa chỉ lưu trong trình duyệt của thiết bị này. Nên giới hạn khóa chỉ dùng cho Gemini API và đặt hạn mức chi tiêu thấp trên Google AI Studio.</p></section>
    <section class="card"><h2>Thông tin nhận tiền</h2>
      <label>Số tài khoản nhận tiền (in vào Giấy đề nghị thanh toán) <input type="text" inputmode="numeric" data-act="bankaccount" value="${esc(s.bankAccount)}" autocomplete="off"></label>
      <p class="muted small">Chỉ lưu trong trình duyệt của thiết bị này, không nằm trong cấu hình hay bản sao lưu.</p></section>
    <section class="card"><h2>Khóa quyền sửa (mã PIN)</h2>
      ${lock.hasPin()
    ? `<p>${lock.canEdit() ? 'Đang <b>mở khóa</b> (tự khóa lại sau 10 phút hoặc khi rời app).' : 'Đang <b>khóa</b>: đơn giá, số dư mái tôn, bù trừ, phản kháng, cấu hình và lịch sử không sửa được.'}</p>
       ${lock.canEdit() ? '<button data-act="relock">Khóa lại ngay</button>' : '<button class="primary" data-act="unlock">Mở khóa</button>'}`
    : '<p>Chưa đặt mã PIN. Đặt PIN để chỉ anh mới sửa được đơn giá và cấu hình trên thiết bị này.</p>'}
      <label>${lock.hasPin() ? 'Đổi mã PIN (cần đang mở khóa)' : 'Mã PIN mới (4 đến 12 ký tự)'} <input type="password" id="newpin" inputmode="numeric" autocomplete="new-password" maxlength="12"></label>
      <button data-act="setpin">${lock.hasPin() ? 'Đổi PIN' : 'Đặt PIN'}</button>
      <p class="muted small">PIN chỉ lưu dạng băm trong trình duyệt của thiết bị này, mỗi thiết bị đặt riêng. Đây là khóa mềm để người khác cầm máy không sửa được số. Quên PIN thì sao lưu lịch sử, xóa dữ liệu trang rồi nạp lại.</p></section>
    <section class="card"><h2>Cấu hình dự án</h2>
      <button data-act="pickimport">Nạp file cấu hình (.json, cần PIN)</button><input type="file" accept=".json" hidden id="importfile" data-act="import">
      <details><summary>Sửa trực tiếp (nâng cao)</summary>
        <textarea id="cfgtext" rows="14" spellcheck="false">${esc(JSON.stringify(cfg, null, 2))}</textarea>
        <button data-act="savecfg">Lưu cấu hình</button></details>
      <p class="muted small">Hiện có ${cfg.projects.length} dự án: ${esc(cfg.projects.map((p) => p.name).join(', ') || 'chưa có')}.</p></section>
    <section class="card"><h2>Giao diện (nhờ Gemini thiết kế)</h2>
      <p>${s.customCss ? `Đang dùng giao diện tùy chỉnh (${Math.round(s.customCss.length / 1024)} KB).` : 'Đang dùng giao diện gốc.'}</p>
      <ol class="small">
        <li>Bấm <b>Tải file gửi Gemini</b> (hoặc <b>Sao chép</b>), gửi file hoặc dán vào Gemini, nhờ làm đẹp lại.</li>
        <li>Copy toàn bộ câu trả lời của Gemini, dán vào ô bên dưới, bấm <b>Áp dụng</b>.</li>
        <li>Không ưng thì bấm <b>Về giao diện gốc</b>.</li></ol>
      <button data-act="themepack">Tải file gửi Gemini</button>
      <button data-act="themecopy">Sao chép nội dung gửi Gemini</button>
      <label>Dán trả lời của Gemini (hoặc chọn file .css) <textarea id="themetext" rows="6" spellcheck="false" placeholder="\`\`\`css ... \`\`\`"></textarea></label>
      <button class="primary" data-act="themeapply">Áp dụng giao diện này</button>
      <button data-act="themereset">Về giao diện gốc</button>
      <label class="btn">Chọn file CSS <input type="file" accept=".css,.txt,.md,.html" hidden data-act="themefile"></label>
      <p class="muted small">Chỉ đổi màu sắc và bố cục, không đổi cách tính. Nếu giao diện mới bị lỗi không bấm được, mở app bằng địa chỉ có thêm <b>?giaodien=goc</b> ở cuối để quay về bản gốc.</p></section>
    <p class="muted small ver">Phiên bản ${APP_VERSION} · đọc ảnh bằng Gemini</p>`;
}

// Gói gửi Gemini: yêu cầu thiết kế + HTML mẫu dựng từ chính hàm hiển thị (số liệu giả) + CSS gốc.
async function geminiPack() {
  const css = await (await fetch('css/style.css', { cache: 'no-store' })).text();
  const p = { id: 'demo', name: 'Dự án mẫu', discount: 0.85, lowZero: true, roof: { share: 0.5 }, reactive: true, meters: [{ id: 'm1', label: 'Công tơ mẫu' }], prices: { normal: 1000, peak: 2000, low: 500 } };
  const start = { normal: 100000, peak: 40000, low: 0 };
  const end = { normal: 112000, peak: 44000, low: 0 };
  const L = { meter: p.meters[0], key: mkey(p.id, 'm1'), start, end: { ...end, total: 156000 }, startFrom: '2026-09' };
  const result = computeProject(p, { hourPrice: 500000, vat: 0.08 }, { readings: { m1: { start, end } }, prices: p.prices, roofBalance: 5000000, reactive: 0 });
  const row = { id: 0, thumb: '', name: 'anh-cong-to-mau.jpg', serial: '12345678', register: '2.8.1', value: 112000, confidence: 'medium', assign: { key: mkey(p.id, 'm1'), slot: 'normal' } };
  const card = projectCard({}, { p, ledgers: [L], missing: [], checks: [{ meter: p.meters[0], ok: true, diff: 0 }], result, roofBalance: 5000000 });
  const sample = `<div id="app">
<header class="top"><h1>Ecoshine · Chốt số</h1></header>
<main>
<section class="card">${periodPicker()}</section>
<section class="card proj"><h2>${p.name}</h2>
  <label class="drop"><input type="file" hidden><b>Chọn nhiều ảnh của ${p.name}</b><span>Ảnh công tơ hoặc ảnh chụp màn hình.</span></label>
  <p class="progress">Đang đọc 2/5 ảnh…</p>
  <div class="rows">${rowCard(p, row)}</div>
  <div class="pcalc">${card}</div></section>
</main>
<nav class="tabs"><button class="on">Chốt tháng</button><button>Xuất file</button><button>Lịch sử</button><button>Cài đặt</button></nav>
<div class="toast">Đã lưu</div>
</div>`;
  return buildBrief({ css, sample, cssUrl: new URL('css/style.css', location.href).href });
}

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- Khóa PIN ----------

function askPin(title, error = '') {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'pin';
    d.innerHTML = `<form method="dialog"><h3>${esc(title)}</h3>
      <input type="password" inputmode="numeric" autocomplete="off" maxlength="12" id="pinbox" aria-label="Mã PIN">
      ${error ? `<p class="pinerr">${esc(error)}</p>` : ''}
      <div class="row"><button value="cancel" type="button" id="pincancel">Hủy</button><button class="primary" value="ok">Mở khóa</button></div></form>`;
    document.body.appendChild(d);
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    d.querySelector('#pincancel').onclick = () => done(null);
    d.addEventListener('cancel', (ev) => { ev.preventDefault(); done(null); });
    d.querySelector('form').onsubmit = (ev) => { ev.preventDefault(); done(d.querySelector('#pinbox').value); };
    d.showModal();
    d.querySelector('#pinbox').focus();
  });
}

// Trả về true khi được phép sửa (chưa đặt PIN, đang mở khóa, hoặc vừa nhập đúng PIN).
async function requireUnlock() {
  if (lock.canEdit()) return true;
  let error = '';
  for (;;) {
    const pin = await askPin('Nhập mã PIN để sửa', error);
    if (pin === null) return false;
    try {
      if (await lock.unlock(pin)) { toast('Đã mở khóa 10 phút'); return true; }
      error = 'PIN sai';
    } catch (err) { error = err.message; }
  }
}

document.addEventListener('visibilitychange', () => {
  if (!lock.hasPin()) return;
  if (document.hidden) lock.lockNow(); else render();
});

// ---------- Đọc ảnh ----------

async function handleFiles(fileList, pid) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/'));
  if (!files.length || !pid) return;
  const { apiKey, model } = store.settings.get();
  if (!apiKey) {
    toast('Chưa có khóa API. Vào Cài đặt nhập khóa trước.');
    return;
  }
  const cfg = store.config.get();
  const prog = state.progress[pid] = { done: 0, total: files.length };
  render();
  const results = await readMany(files, {
    apiKey, model: model && !/^claude/i.test(model) ? model : DEFAULT_MODEL,
    onProgress: (i, st) => {
      if (st === 'done' || st === 'error') {
        prog.done += 1;
        const el = document.querySelector(`.progress[data-pid="${CSS.escape(pid)}"]`);
        if (el) el.textContent = `Đang đọc ${prog.done}/${prog.total} ảnh…`;
      }
    },
  });
  for (const res of results) {
    if (!res.ok) {
      state.rows.push({ id: ++rowSeq, pid, name: res.name, error: res.error });
      continue;
    }
    const { parsed } = res;
    let added = 0;
    for (const m of parsed.meters || []) {
      for (const rd of m.readings || []) {
        state.rows.push({
          id: ++rowSeq, pid, name: res.name, thumb: res.thumb, serial: m.serial, register: rd.register,
          value: typeof rd.value === 'number' ? rd.value : null, confidence: rd.confidence,
          photoTime: parsed.photo_time, note: parsed.note, assign: autoAssign(cfg, pid, m.serial, rd.register),
        });
        added += 1;
      }
    }
    if (!added) state.rows.push({ id: ++rowSeq, pid, name: res.name, thumb: res.thumb, note: parsed.note || 'Không thấy chỉ số trong ảnh', error: 'Không đọc được chỉ số' });
  }
  delete state.progress[pid];
  rebuildEnds();
  render();
}

// ---------- Sự kiện ----------

$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (el.hasAttribute('data-lock') && el.readOnly) {
    if (await requireUnlock()) render();
    return;
  }
  if (act === 'tab') { state.tab = el.dataset.tab; render(); }
  else if (act === 'pickimport') { if (await requireUnlock()) document.getElementById('importfile').click(); }
  else if (act === 'unlock') { if (await requireUnlock()) render(); }
  else if (act === 'relock') { lock.lockNow(); render(); }
  else if (act === 'setpin') {
    const box = document.getElementById('newpin');
    if (!lock.validPin(box.value)) { toast('Mã PIN từ 4 đến 12 ký tự'); return; }
    if (!(await requireUnlock())) return;
    await lock.setPin(box.value);
    toast('Đã lưu mã PIN');
    render();
  } else if (act === 'rowdel') {
    const id = Number(el.closest('[data-row]').dataset.row);
    state.rows = state.rows.filter((r) => r.id !== id);
    state.ends = {};
    rebuildEnds();
    render();
  } else if (act === 'close') closeMonth(el.dataset.p);
  else if (act === 'histdel') {
    if (!(await requireUnlock())) return;
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
  } else if (act === 'themepack') {
    saveBlob('ecoshine-giao-dien-gui-gemini.txt', new Blob([await geminiPack()], { type: 'text/plain;charset=utf-8' }));
  } else if (act === 'themecopy') {
    try { await navigator.clipboard.writeText(await geminiPack()); toast('Đã sao chép, dán vào Gemini'); } catch { toast('Không sao chép được, hãy dùng nút Tải file'); }
  } else if (act === 'themeapply') {
    setTheme(extractCss(document.getElementById('themetext').value));
  } else if (act === 'themereset') {
    setTheme('');
  } else if (act === 'savecfg') {
    if (!(await requireUnlock())) return;
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
  if (act === 'files') { const pid = el.dataset.pid; const list = [...el.files]; el.value = ''; await handleFiles(list, pid); }
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
    if (act === 'rowkey') { delete r.assign.foreign; delete r.assign.serialMismatch; }
    state.ends = {}; rebuildEnds(); render();
  } else if (act === 'apikey' || act === 'model') {
    const s = store.settings.get();
    s[act === 'apikey' ? 'apiKey' : 'model'] = el.value.trim();
    store.settings.set(s);
    toast('Đã lưu');
  } else if (act === 'themefile') {
    const f = el.files[0];
    el.value = '';
    if (f) document.getElementById('themetext').value = await f.text();
  } else if (act === 'import') {
    if (!lock.canEdit()) { el.value = ''; toast('Cần mở khóa bằng PIN'); return; }
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
  if ((act === 'manual' || act === 'price') && !lock.canEdit()) { toast('Đã khóa lại, chạm vào ô để nhập PIN'); render(); return; }
  if (act === 'end') { (state.ends[el.dataset.k] ||= {})[el.dataset.s] = v; renderResults(); refocus(el); }
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
  const next = document.querySelector(`.pcalc ${sel}`);
  if (next && next !== el) {
    next.focus();
    const n = next.value.length;
    try { next.setSelectionRange(n, n); } catch { /* input number không hỗ trợ */ }
  }
}

// Dán ảnh (Ctrl+V) chỉ vào dự án anh vừa chạm; thả ảnh thì vào đúng ô nhập anh thả.
$app.addEventListener('pointerdown', (e) => {
  const s = e.target.closest('.proj');
  if (s) state.activePid = s.dataset.pid;
});
document.addEventListener('paste', (e) => {
  if (state.tab !== 'chot') return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  if (!state.activePid) { toast('Chạm vào ô của dự án trước rồi hãy dán ảnh'); return; }
  handleFiles(files, state.activePid);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const zone = e.target.closest?.('.drop');
  if (state.tab !== 'chot' || !e.dataTransfer?.files?.length) return;
  if (!zone) { toast('Thả ảnh vào đúng ô của dự án'); return; }
  handleFiles(e.dataTransfer.files, zone.dataset.pid);
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
    reactive: state.manual[pid]?.reactive || 0, adjust: state.manual[pid]?.adjust || 0, roofBalanceBefore: c.p.roof ? Number(c.roofBalance || 0) : undefined,
    roofBalanceAfter: roofAfter, closedAt: new Date().toISOString(),
  };
  state.exported = null;
  if (!store.history.set(hist)) { toast('Không lưu được vào trình duyệt'); return; }
  toast(`Đã chốt ${c.p.name} kỳ ${key}: ${fmt.n1(c.result.hours)} giờ`);
  renderResults();
}

function setTheme(css) {
  const err = css ? checkCss(css) : '';
  if (err) { toast(err); return; }
  const s = store.settings.get();
  if (css) s.customCss = css; else delete s.customCss;
  if (!store.settings.set(s)) { toast('Không lưu được vào trình duyệt, CSS có thể quá lớn'); return; }
  applyCss(css);
  toast(css ? 'Đã áp dụng giao diện mới' : 'Đã về giao diện gốc');
  render();
}

// Lối thoát: giao diện tùy chỉnh bị lỗi thì mở địa chỉ kèm ?giaodien=goc để xóa nó.
if (new URLSearchParams(location.search).get('giaodien') === 'goc') {
  const s = store.settings.get();
  delete s.customCss;
  store.settings.set(s);
  history.replaceState(null, '', location.pathname);
}
applyCss(store.settings.get().customCss || '');

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

render();
