// Xuất bộ file chốt tháng: file gửi khách (chỉ số giờ), file nội bộ (có kWh), file số liệu xuất hóa đơn.
// Dựng thẳng bằng ExcelJS theo đúng bố cục các file tháng trước; mọi tên, hợp đồng, người ký lấy từ cấu hình riêng.

import { SLOTS, SLOT_LABEL, computeProject, lastDayOfMonth } from './engine.js';

const FONT = 'Times New Roman';
const THIN = { style: 'thin' };
const BOX = { left: THIN, right: THIN, top: THIN, bottom: THIN };
const MONEY = '_(* #,##0_);_(* \\(#,##0\\);_(* "-"??_);_(@_)';
const pad2 = (n) => String(n).padStart(2, '0');

let excelPromise;
export function loadExcelJS() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  excelPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./vendor/exceljs.min.js', import.meta.url).href;
    s.onload = () => resolve(window.ExcelJS);
    s.onerror = () => reject(new Error('Không tải được thư viện Excel'));
    document.head.appendChild(s);
  });
  return excelPromise;
}

// ---------- tiện ích dựng ô ----------

function put(ws, addr, value, o = {}) {
  const c = ws.getCell(addr);
  c.value = value;
  c.font = { name: FONT, size: o.size || 12, bold: !!o.bold, italic: !!o.italic };
  c.alignment = { horizontal: o.h, vertical: o.v || 'middle', wrapText: !!o.wrap };
  if (o.fmt) c.numFmt = o.fmt;
  if (o.border) c.border = BOX;
  return c;
}

function merge(ws, range, value, o) {
  ws.mergeCells(range);
  put(ws, range.split(':')[0], value, o);
  if (o?.border) forRange(ws, range, (c) => { c.border = BOX; });
}

function forRange(ws, range, fn) {
  const [a, b] = range.split(':');
  const col = (s) => s.match(/[A-Z]+/)[0].split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const row = (s) => Number(s.match(/\d+/)[0]);
  for (let r = row(a); r <= row(b); r++) for (let c = col(a); c <= col(b); c++) fn(ws.getCell(r, c));
}

function baseSheet(wb, name, { cols, printArea, margins, scale }) {
  const ws = wb.addWorksheet(name, {
    views: [{ showGridLines: false }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: margins || { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 }, scale },
  });
  cols.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  if (printArea) ws.pageSetup.printArea = printArea;
  return ws;
}

const SIGN_DATE = (year, month, place) => `Hôm nay, ngày ${pad2(lastDayOfMonth(year, month))} tháng ${pad2(month)} năm ${year}, tại ${place}, chúng tôi gồm các Bên dưới đây:`;
const CONTRACT_LINE = (b) => `- Căn cứ vào hợp đồng số ${b.contract.no} ký ngày ${b.contract.date}`;
const CONTRACT_SHORT = (b) => `${b.contract.no} ký ngày ${b.contract.date}`;

function parties(cfg, project) {
  const b = project.billing;
  const co = cfg.company;
  return { b, co };
}

// ---------- File gửi khách: biên bản số giờ + giấy đề nghị thanh toán ----------

export function buildClientWorkbook(ExcelJS, cfg, project, period, hours, settings) {
  const { b, co } = parties(cfg, project);
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const { year, month } = period;
  const honorA = b.partyA.honorific || 'Ông';
  const honorB = co.director?.honorific || 'Ông';

  // --- Sheet 1: biên bản số giờ ---
  let ws = baseSheet(wb, 'BB Chốt số giờ sử dụng', {
    cols: [9.1, 5.4, 23.2, 24.5, 11.9, 17.5, 19.4, 10.4, 9.1],
    printArea: 'B1:H21', margins: { left: 0.35, right: 0.35, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  });
  const H = { 3: 6.75, 4: 19, 5: 9, 6: 15.5, 7: 33.75, 8: 17.25, 9: 17.25, 10: 17.25, 11: 17.25, 12: 17.25, 13: 17.25, 15: 33, 19: 17.25, 20: 21 };
  Object.entries(H).forEach(([r, h]) => { ws.getRow(Number(r)).height = h; });
  merge(ws, 'B1:H1', 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { bold: true, h: 'center' });
  merge(ws, 'B2:H2', 'Độc Lập – Tự Do – Hạnh Phúc', { bold: true, h: 'center' });
  ws.mergeCells('B3:H3');
  merge(ws, 'B4:H4', 'BIÊN BẢN XÁC NHẬN THỜI GIAN SỬ DỤNG', { bold: true, size: 15, h: 'center' });
  ws.mergeCells('B5:H5');
  merge(ws, 'B6:I6', CONTRACT_LINE(b), { h: 'left', wrap: true });
  merge(ws, 'B7:H7', SIGN_DATE(year, month, b.place), { h: 'left', wrap: true });
  merge(ws, 'B8:H8', `I. Đại diện Bên A:  ${b.partyA.name}`, { bold: true });
  merge(ws, 'C9:F9', `1. ${honorA}:  ${b.partyA.rep}`, { h: 'left' });
  put(ws, 'G9', `Chức vụ: ${b.partyA.title}`, { h: 'left' });
  merge(ws, 'C10:F10', `2. ${b.partyA.second ? `${b.partyA.second.honorific || 'Ông'}:  ${b.partyA.second.rep}` : `${honorA}:`}`, { h: 'left' });
  put(ws, 'G10', `Chức vụ: ${b.partyA.second?.title || ''}`, { h: 'left' });
  merge(ws, 'B11:H11', `II. Đại diện Bên B: ${co.name}`, { bold: true });
  merge(ws, 'C12:F12', `1. ${honorB}: ${co.director.rep}`, { h: 'left' });
  put(ws, 'G12', `Chức vụ: ${co.director.title} `, { h: 'left' });
  merge(ws, 'C13:F13', `2. ${co.technician?.honorific || 'Ông'} : ${co.technician?.rep || ''}`, { h: 'left' });
  put(ws, 'G13', `Chức vụ: ${co.technician?.title || ''}`, { h: 'left' });
  merge(ws, 'B15:H15', `Hai bên thỏa thuận ký xác nhận thời gian sử dụng hệ thống điện mặt trời tại ${b.partyA.display} trong tháng như sau:`, { italic: true, h: 'left', wrap: true });
  merge(ws, 'B16:D16', 'Số giờ sử dụng hệ thống trong tháng (giờ):', { italic: true, h: 'left', wrap: true });
  put(ws, 'E16', hours, { bold: true, italic: true, h: 'left', wrap: true });
  merge(ws, 'B18:H18', '-Biên bản được lập từ ngày ký, kết quả dùng để tính toán thanh toán tiền thuê hệ thống điện mặt trời trong tháng.', { wrap: true });
  merge(ws, 'B19:H19', '-Biên bản được lập thành 02 bản có giá trị pháp lý như nhau, mỗi bên giữ 01 bản', { h: 'left', wrap: true });
  merge(ws, 'B20:D21', b.partyA.name, { bold: true, h: 'center' });
  merge(ws, 'E20:G21', co.name, { bold: true, h: 'center' });

  // --- Sheet 2: giấy đề nghị thanh toán ---
  const price = cfg.company.hourPrice;
  const before = Math.round(hours * price);
  const vat = Math.round(before * cfg.company.vat);
  ws = baseSheet(wb, 'Giấy ĐNTN', {
    cols: [5.6, 27, 23.8, 18.6, 25.9, 10.6, 13.9, 9.1],
    printArea: 'A1:E18', margins: { left: 0.63, right: 0.63, top: 0.67, bottom: 0.67, header: 0.3, footer: 0.3 },
  });
  Object.entries({ 4: 18, 5: 16.5, 6: 9, 9: 38, 10: 55.5, 11: 15.75, 12: 45.65, 15: 20.25, 16: 29.5, 17: 159.5, 18: 15.5 }).forEach(([r, h]) => { ws.getRow(Number(r)).height = h; });
  merge(ws, 'A1:E1', 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { bold: true, h: 'center' });
  merge(ws, 'A2:E2', 'Độc Lập – Tự Do – Hạnh Phúc', { bold: true, h: 'center' });
  ws.mergeCells('A3:E3');
  merge(ws, 'A4:E4', `GIẤY ĐỀ NGHỊ THANH TOÁN TIỀN THUÊ HỆ THỐNG ĐIỆN MẶT TRỜI THÁNG ${pad2(month)}/${year}`, { bold: true, h: 'center' });
  ws.mergeCells('A5:E5');
  put(ws, 'A7', `Kính gửi: ${b.partyA.display}`, {});
  merge(ws, 'A9:H9', `${CONTRACT_LINE(b)}\n- Căn cứ biên bản xác nhận thời gian sử dụng trong tháng`, { h: 'left', wrap: true });
  merge(ws, 'A10:E10', ` Bên A (${b.partyA.short}) sẽ tiến hành thanh toán tiền thuê hệ thống điện mặt trời trong tháng cho Bên B (${co.shortName}) chi tiết như sau: `, { h: 'left', wrap: true });
  merge(ws, 'A11:A12', 'TT', { bold: true, h: 'center', wrap: true, border: true });
  merge(ws, 'B11:B12', 'Số giờ sử dụng hệ thống trong tháng (giờ)', { bold: true, h: 'center', wrap: true, border: true });
  merge(ws, 'C11:D12', 'Đơn giá chưa VAT\n(VNĐ/giờ)', { bold: true, h: 'center', wrap: true, border: true });
  merge(ws, 'E11:E12', 'Thành tiền\n(VNĐ)', { bold: true, h: 'center', wrap: true, border: true });
  put(ws, 'A13', '(1)', { italic: true, h: 'center', wrap: true, border: true });
  put(ws, 'B13', '(2)', { italic: true, h: 'center', wrap: true, border: true });
  merge(ws, 'C13:D13', '(3)', { italic: true, h: 'center', wrap: true, border: true });
  put(ws, 'E13', '(4)=(2)*(3)', { italic: true, h: 'center', wrap: true, border: true });
  put(ws, 'A14', 1, { h: 'center', wrap: true, border: true });
  put(ws, 'B14', { formula: "'BB Chốt số giờ sử dụng'!E16", result: hours }, { h: 'center', wrap: true, border: true, fmt: '#,##0.0' });
  merge(ws, 'C14:D14', price, { fmt: MONEY, border: true });
  put(ws, 'E14', { formula: 'B14*C14', result: before }, { h: 'left', fmt: MONEY, border: true });
  merge(ws, 'A15:D15', `THUẾ GTGT ${Math.round(cfg.company.vat * 100)}%`, { bold: true, h: 'center', border: true });
  put(ws, 'E15', { formula: `E14*${Math.round(cfg.company.vat * 100)}%`, result: vat }, { bold: true, fmt: MONEY, border: true });
  merge(ws, 'A16:D16', 'TỔNG SỐ TIỀN THANH TOÁN (ĐÃ BAO GỒM VAT)', { bold: true, h: 'center', wrap: true, border: true });
  put(ws, 'E16', { formula: 'E14+E15', result: before + vat }, { bold: true, wrap: true, fmt: MONEY, border: true });
  const account = (settings.bankAccount || '').trim() || '………………………';
  merge(ws, 'A17:E17', [
    '- Vậy, chúng tôi kính đề nghị quý công ty thanh toán số tiền trên.',
    '  - Việc thanh toán sẽ được thực hiện qua tài khoản ngân hàng theo thông tin sau đây:',
    '- Thông tin chuyển khoản: ',
    `- Tên tài khoản: ${co.bank.holder}`,
    `- Tài khoản số: ${account}`,
    `- Tại Ngân hàng: ${co.bank.bankName}`,
    '- Rất mong nhận được sự hợp tác từ quý công ty.',
    'Chúng tôi xin trân trọng cảm ơn!',
  ].join('\n'), { italic: true, h: 'left', wrap: true });
  ws.mergeCells('A18:C18');
  merge(ws, 'D18:E18', co.name, { bold: true, h: 'center', wrap: true });
  return { wb, missingAccount: !(settings.bankAccount || '').trim() };
}

// ---------- File nội bộ: biên bản chỉ số + bảng tính tiền (có kWh) ----------

export function buildInternalWorkbook(ExcelJS, cfg, project, period, record, history = {}) {
  const { b, co } = parties(cfg, project);
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const { year, month } = period;
  const integer = project.integerReadings !== false;
  const input = { readings: record.readings, prices: record.prices, roofBalance: record.roofBalanceBefore, reactive: record.reactive, adjust: record.adjust };
  const res = computeProject(project, cfg.company, input);
  const TRACK = 'Theo dõi mái tôn';

  // --- Sheet "Chốt số" ---
  let ws = baseSheet(wb, 'Chốt số', { cols: [2, 6, 22, 28, 15, 15, 20, 12], printArea: undefined });
  merge(ws, 'B1:H1', 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { bold: true, h: 'center' });
  merge(ws, 'B2:H2', 'Độc Lập – Tự Do – Hạnh Phúc', { bold: true, h: 'center' });
  merge(ws, 'B4:H4', 'KIỂM ĐẾM CHỈ SỐ SỬ DỤNG', { bold: true, size: 15, h: 'center' });
  merge(ws, 'B6:H6', CONTRACT_LINE(b), { h: 'left', wrap: true });
  merge(ws, 'B7:H7', SIGN_DATE(year, month, b.place), { h: 'left', wrap: true });
  ws.getRow(7).height = 33.75;
  merge(ws, 'B8:H8', `I. Đại diện Bên A: ${b.partyA.name}`, { bold: true });
  merge(ws, 'C9:F9', `1. ${b.partyA.honorific || 'Ông'}: ${b.partyA.rep}`, { h: 'left' });
  put(ws, 'G9', `Chức vụ: ${b.partyA.title}`, { h: 'left' });
  merge(ws, 'B10:H10', `II. Đại diện Bên B: ${co.name}`, { bold: true });
  merge(ws, 'C11:F11', `1. ${co.director.honorific || 'Ông'}: ${co.director.rep}`, { h: 'left' });
  put(ws, 'G11', `Chức vụ: ${co.director.title}`, { h: 'left' });
  merge(ws, 'B12:H12', `Hai bên thỏa thuận ký xác nhận biên bản chốt chỉ số công tơ tại ${b.partyA.display} trong tháng với các danh mục cụ thể sau:`, { h: 'left', wrap: true });
  ws.getRow(12).height = 33;
  ['B14:B15', 'C14:C15', 'D14:D15', 'H14:H15'].forEach((r, i) => merge(ws, r, ['Stt', 'Tên thiết bị', 'Khung giờ', 'Ghi chú'][i], { bold: true, h: 'center', wrap: true, border: true }));
  merge(ws, 'E14:F14', 'Chỉ số', { bold: true, h: 'center', border: true });
  merge(ws, 'G14:G15', 'Chỉ số sử dụng trong tháng (kWh)', { bold: true, h: 'center', wrap: true, border: true });
  put(ws, 'E15', 'Đầu kỳ', { bold: true, h: 'center', border: true });
  put(ws, 'F15', 'Cuối kỳ', { bold: true, h: 'center', border: true });
  const fix = (v) => (integer ? Math.round(Number(v) || 0) : Number(v) || 0);
  let r = 16;
  const kwhCell = {}; // `${meterId}|${slot}` -> địa chỉ ô kWh ở sheet Chốt số
  project.meters.forEach((m, mi) => {
    const rd = record.readings[m.id];
    SLOTS.forEach((s, si) => {
      const row = r + si;
      if (si === 0) {
        merge(ws, `B${row}:B${row + 2}`, mi + 1, { h: 'center', border: true });
        merge(ws, `C${row}:C${row + 2}`, m.label || m.id, { h: 'center', wrap: true, border: true });
      }
      const code = `${m.reg || '2.8'}.${si + 1}`;
      put(ws, `D${row}`, `${SLOT_LABEL[s]} (${code})`, { border: true });
      put(ws, `E${row}`, fix(rd.start[s]), { h: 'right', fmt: '#,##0', border: true });
      put(ws, `F${row}`, fix(rd.end[s]), { h: 'right', fmt: '#,##0', border: true });
      put(ws, `G${row}`, { formula: `F${row}-E${row}`, result: fix(rd.end[s]) - fix(rd.start[s]) }, { h: 'right', fmt: '#,##0', border: true });
      put(ws, `H${row}`, '', { border: true });
      kwhCell[`${m.id}|${s}`] = `'Chốt số'!G${row}`;
    });
    r += 3;
  });
  // Nhiều công tơ: thêm khối "Tổng cộng" theo từng khung giờ; bảng thanh toán lấy từ khối này.
  const kwhRef = {};
  if (project.meters.length > 1) {
    SLOTS.forEach((s, si) => {
      const row = r + si;
      if (si === 0) {
        merge(ws, `B${row}:B${row + 2}`, project.meters.length + 1, { h: 'center', border: true });
        merge(ws, `C${row}:C${row + 2}`, 'Tổng cộng', { h: 'center', wrap: true, border: true });
      }
      put(ws, `D${row}`, `${SLOT_LABEL[s]} (${project.meters[0].reg || '2.8'}.${si + 1})`, { border: true });
      put(ws, `E${row}`, '', { border: true });
      put(ws, `F${row}`, '', { border: true });
      put(ws, `G${row}`, { formula: project.meters.map((m) => kwhCell[`${m.id}|${s}`].replace("'Chốt số'!", '')).join('+'), result: res.kwh[s] }, { h: 'right', fmt: '#,##0', border: true });
      put(ws, `H${row}`, '', { border: true });
      kwhRef[s] = `'Chốt số'!G${row}`;
    });
    r += 3;
  } else {
    SLOTS.forEach((s) => { kwhRef[s] = kwhCell[`${project.meters[0].id}|${s}`]; });
  }
  merge(ws, `B${r + 1}:H${r + 1}`, '-Biên bản được lập từ ngày ký, kết quả dùng để tính toán thanh toán tiền thuê hệ thống điện mặt trời tháng.', { h: 'left', wrap: true });
  merge(ws, `B${r + 2}:H${r + 2}`, '-Biên bản được lập thành 02 bản có giá trị pháp lý như nhau, mỗi bên giữ 01 bản', { h: 'left', wrap: true });
  merge(ws, `B${r + 4}:E${r + 4}`, b.partyA.name, { bold: true, h: 'center' });
  merge(ws, `F${r + 4}:H${r + 4}`, co.name, { bold: true, h: 'center' });

  // --- Sheet "Thanh toán" ---
  ws = baseSheet(wb, 'Thanh toán', { cols: [6, 24, 26, 16, 14, 18, 20, 20, 12] });
  merge(ws, 'A1:I1', 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM', { bold: true, h: 'center' });
  merge(ws, 'A2:I2', 'Độc Lập – Tự Do – Hạnh Phúc', { bold: true, h: 'center' });
  merge(ws, 'A4:I4', `GIÁ TRỊ THANH TOÁN THUÊ HỆ THỐNG ĐIỆN MẶT TRỜI  THÁNG ${month} NĂM ${year}`, { bold: true, size: 14, h: 'center' });
  merge(ws, 'A6:I6', CONTRACT_LINE(b), { h: 'left' });
  merge(ws, 'A7:I7', SIGN_DATE(year, month, b.place), { h: 'left', wrap: true });
  merge(ws, 'A8:I8', `I. Đại diện Bên A: ${b.partyA.name}`, { bold: true });
  merge(ws, 'A9:I9', `${b.partyA.honorific || 'Ông'}:      ${b.partyA.rep}                            Chức vụ: ${b.partyA.title}`, { h: 'left' });
  merge(ws, 'A10:I10', `II. Đại diện Bên B: ${co.name}`, { bold: true });
  merge(ws, 'A11:I11', `${co.director.honorific || 'Ông'}: ${co.director.rep}            Chức vụ: ${co.director.title}`, { h: 'left' });
  merge(ws, 'A12:I12', `${co.accountant?.honorific || 'Bà'}: ${co.accountant?.rep || ''}                     Chức vụ: ${co.accountant?.title || ''}`, { h: 'left' });
  merge(ws, 'A14:I14', 'Hai bên thỏa thuận ký biên bản xác nhận giá trị thanh toán tiền thuê hệ thống điện mặt trời tháng như sau:', { h: 'left', wrap: true });
  const heads = ['Stt', 'Tên thiết bị', 'Khung giờ', 'Chỉ số sử dụng trong tháng (kWh)', 'Đơn giá chưa VAT\n(VNĐ)', 'Thành tiền\n(VNĐ)', `Tiền sử dụng (VNĐ)`, `Tiền tiết kiệm (VNĐ)`];
  heads.forEach((t, i) => put(ws, `${'ABCDEFGH'[i]}15`, t, { bold: true, h: 'center', wrap: true, border: true }));
  ws.getRow(15).height = 48;
  const pct = Math.round(project.discount * 100);
  ['(1)', '(2)', '(3)', '(4)', '(5)', '(6)=(4)*(5)', `(7)=(6)*${pct}%`, `(8)=(6)*${100 - pct}%`].forEach((t, i) => put(ws, `${'ABCDEFGH'[i]}16`, t, { italic: true, h: 'center', border: true }));
  let row = 17;
  const first = row;
  // Mỗi khung giờ một dòng; nhiều công tơ thì kWh là tổng các công tơ (như file các tháng trước).
  SLOTS.forEach((s) => {
    const u = res.kwh[s];
    const money = u * (record.prices[s] || 0);
    put(ws, `A${row}`, s === 'normal' ? 1 : '', { h: 'center', border: true });
    put(ws, `B${row}`, s === 'normal' ? (project.meters.length > 1 ? 'Công tơ' : (project.meters[0].label || project.meters[0].id)) : '', { border: true });
    put(ws, `C${row}`, SLOT_LABEL[s], { border: true });
    put(ws, `D${row}`, { formula: kwhRef[s], result: u }, { h: 'right', fmt: '#,##0', border: true });
    put(ws, `E${row}`, record.prices[s] || 0, { h: 'right', fmt: '#,##0', border: true });
    put(ws, `F${row}`, { formula: `D${row}*E${row}`, result: money }, { h: 'right', fmt: '#,##0', border: true });
    put(ws, `G${row}`, { formula: `F${row}*${project.discount}`, result: money * project.discount }, { h: 'right', fmt: '#,##0', border: true });
    put(ws, `H${row}`, { formula: `F${row}-G${row}`, result: money - money * project.discount }, { h: 'right', fmt: '#,##0', border: true });
    row += 1;
  });
  const last = row - 1;
  const line = (label, f, result, o = {}) => {
    merge(ws, `A${row}:E${row}`, label, { bold: true, h: 'center', border: true });
    ['F', 'G', 'H'].forEach((col) => {
      const spec = f[col];
      put(ws, `${col}${row}`, spec ? { formula: spec, result: result[col] } : '', { bold: true, h: 'right', fmt: '#,##0', border: true });
    });
    row += 1;
    return row - 1;
  };
  const rTotal = line('TỔNG', { F: `SUM(F${first}:F${last})`, G: `SUM(G${first}:G${last})`, H: `SUM(H${first}:H${last})` }, { F: res.total, G: res.use, H: res.saving });
  let rBase = rTotal;
  if (project.roof || project.adjust || project.reactive) {
    // Mái tôn cộng (thu hồi chi phí đã ứng), bù trừ có dấu, phản kháng trừ.
    const sharePct = Math.round((project.roof?.share ?? 0.5) * 100);
    const parts = [];
    if (project.roof) parts.push([`CHI PHÍ KHẤU TRỪ SỬA MÁI TÔN (= (8)*${sharePct}%)`, res.adjustments.roof, `'${TRACK}'!B6`]);
    if (project.adjust) parts.push([String(project.adjust.label || 'Bù trừ kỳ trước').toUpperCase(), res.adjustments.adjust, null]);
    if (project.reactive) parts.push(['CHI PHÍ HỖ TRỢ PHẠT CÔNG SUẤT PHẢN KHÁNG (EVN)', -res.adjustments.reactive, null]);
    for (const [label, amount, formula] of parts) {
      merge(ws, `A${row}:E${row}`, label, { h: 'center', wrap: true, border: true });
      ['F', 'H'].forEach((c) => put(ws, `${c}${row}`, '', { border: true }));
      put(ws, `G${row}`, formula ? { formula, result: amount } : amount, { h: 'right', fmt: '#,##0', border: true });
      row += 1;
    }
    merge(ws, `A${row}:E${row}`, project.roof ? 'TỔNG SỐ TIỀN BÊN A THANH TOÁN VÀ CHI PHÍ KHẤU TRỪ SỬA MÁI TÔN' : 'TIỀN SỬ DỤNG SAU ĐIỀU CHỈNH', { bold: true, h: 'center', wrap: true, border: true });
    ['F', 'H'].forEach((c) => put(ws, `${c}${row}`, '', { border: true }));
    put(ws, `G${row}`, { formula: `G${rTotal}+SUM(G${rTotal + 1}:G${row - 1})`, result: res.base }, { bold: true, h: 'right', fmt: '#,##0', border: true });
    rBase = row;
    row += 1;
  }
  const vatPct = Math.round(cfg.company.vat * 100);
  const vatRow = row;
  merge(ws, `A${row}:E${row}`, `THUẾ VAT ${vatPct}%`, { bold: true, h: 'center', border: true });
  put(ws, `F${row}`, '', { border: true });
  put(ws, `G${row}`, { formula: `G${rBase}*${vatPct}%`, result: res.base * cfg.company.vat }, { bold: true, h: 'right', fmt: '#,##0', border: true });
  put(ws, `H${row}`, { formula: `H${rTotal}*${vatPct}%`, result: res.saving * cfg.company.vat }, { bold: true, h: 'right', fmt: '#,##0', border: true });
  put(ws, `I${row}`, 'Số giờ', { bold: true, h: 'center' });
  row += 1;
  merge(ws, `A${row}:E${row}`, 'TỔNG SỐ TIỀN BÊN A THANH TOÁN BAO GỒM THUẾ VAT', { bold: true, h: 'center', border: true });
  put(ws, `F${row}`, '', { border: true });
  put(ws, `G${row}`, { formula: `G${rBase}+G${vatRow}`, result: res.withVat }, { bold: true, h: 'right', fmt: '#,##0', border: true });
  put(ws, `H${row}`, { formula: `H${rTotal}+H${vatRow}`, result: res.saving * (1 + cfg.company.vat) }, { bold: true, h: 'right', fmt: '#,##0', border: true });
  put(ws, `I${row}`, { formula: `G${row}/${1 + cfg.company.vat}/${cfg.company.hourPrice}`, result: res.hoursRaw }, { bold: true, h: 'center', fmt: '0.00' });
  row += 2;
  merge(ws, `A${row}:I${row}`, 'Bằng chữ: ', { h: 'left' });
  row += 1;
  merge(ws, `A${row}:I${row}`, '    Phụ lục được lập thành 02 bản có giá trị pháp lý như nhau, mỗi bên giữ 01 bản', { h: 'left' });
  row += 2;
  merge(ws, `A${row}:D${row}`, b.partyA.name, { bold: true, h: 'center' });
  merge(ws, `E${row}:I${row}`, co.name, { bold: true, h: 'center' });

  if (project.roof) addRoofSheet(wb, TRACK, project, period, record, res, rTotal, history);
  return { wb, result: res };
}

// Bảng theo dõi thu hồi chi phí mái tôn (nội bộ): số dư đầu kỳ do anh nhập, các tháng sau tự trừ lùi.
function addRoofSheet(wb, name, project, period, record, res, rTotal, history) {
  const ws = baseSheet(wb, name, { cols: [46, 22, 22, 22] });
  const share = project.roof.share ?? 0.5;
  const before = Number(record.roofBalanceBefore) || 0;
  merge(ws, 'A1:D1', 'BẢNG THEO DÕI KHẤU TRỪ CHI PHÍ SỬA MÁI TÔN (NỘI BỘ)', { bold: true, size: 14, h: 'center' });
  const line = (r, label, v, o = {}) => {
    put(ws, `A${r}`, label, { border: true, wrap: true });
    put(ws, `B${r}`, v, { border: true, h: 'right', fmt: o.fmt || '#,##0', bold: !!o.bold });
  };
  line(3, 'Tỷ lệ khấu trừ trên tiền tiết kiệm', share, { fmt: '0%' });
  line(4, 'Tiền tiết kiệm của tháng (VNĐ)', { formula: `'Thanh toán'!H${rTotal}`, result: res.saving });
  line(5, 'Số dư còn phải thu hồi đầu kỳ (VNĐ)', before);
  line(6, 'Thu hồi trong tháng (VNĐ)', { formula: 'MIN(B4*B3,B5)', result: res.adjustments.roof });
  line(7, 'Số dư còn phải thu hồi cuối kỳ (VNĐ)', { formula: 'B5-B6', result: before - res.adjustments.roof }, { bold: true });
  ['Tháng', 'Đầu kỳ (VNĐ)', 'Thu hồi (VNĐ)', 'Cuối kỳ (VNĐ)'].forEach((t, i) => put(ws, `${'ABCD'[i]}9`, t, { bold: true, h: 'center', border: true }));
  let r = 10;
  const key = `${period.year}-${pad2(period.month)}`;
  for (const k of Object.keys(history).filter((x) => x <= key).sort()) {
    const h = history[k]?.[project.id];
    if (h?.roofBalanceBefore === undefined) continue;
    put(ws, `A${r}`, `${k.slice(5)}/${k.slice(0, 4)}`, { h: 'center', border: true });
    put(ws, `B${r}`, h.roofBalanceBefore, { h: 'right', fmt: '#,##0', border: true });
    put(ws, `C${r}`, h.roofBalanceBefore - h.roofBalanceAfter, { h: 'right', fmt: '#,##0', border: true });
    put(ws, `D${r}`, h.roofBalanceAfter, { h: 'right', fmt: '#,##0', border: true });
    r += 1;
  }
}

// ---------- File tổng hợp cho kế toán xuất hóa đơn ----------

export function buildInvoiceWorkbook(ExcelJS, cfg, period, hoursByProject) {
  const wb = new ExcelJS.Workbook();
  wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet('Sheet1');
  [6.5, 16.6, 26.5, 9.7, 11.1, 14.6, 14.6, 27.4, 10.1].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  const cal = (addr, v, o = {}) => {
    const c = ws.getCell(addr);
    c.value = v;
    c.font = { name: 'Calibri', size: 11, bold: !!o.bold };
    c.alignment = { wrapText: true, vertical: 'top' };
    if (o.fmt) c.numFmt = o.fmt;
  };
  cal('A1', 'Số liệu xuất hóa đơn', { bold: true });
  ['Tháng', 'Tên công ty', 'Hợp đồng số', 'Số giờ sử\n dụng (giờ)', 'Đơn giá', 'Thành tiền \ntrước VAT', 'Sau VAT', 'Địa chỉ email nhận hóa đơn', 'Dự án']
    .forEach((t, i) => cal(`${'ABCDEFGHI'[i]}3`, t, { bold: true }));
  const price = cfg.company.hourPrice;
  const vatMul = 1 + cfg.company.vat;
  let r = 4;
  for (const p of cfg.projects) {
    const inv = p.billing?.invoice;
    if (!inv) continue;
    const hours = hoursByProject[p.id];
    if (r === 4) cal(`A${r}`, new Date(Date.UTC(period.year, period.month - 1, 1)), { fmt: 'mmm-yy' });
    cal(`B${r}`, inv.companyName);
    cal(`C${r}`, inv.contractText);
    if (typeof hours === 'number') {
      const before = hours * price;
      cal(`D${r}`, hours);
      cal(`E${r}`, price, { fmt: MONEY });
      cal(`F${r}`, { formula: `D${r}*E${r}`, result: before }, { fmt: MONEY });
      cal(`G${r}`, { formula: `F${r}*${vatMul}`, result: before * vatMul }, { fmt: MONEY });
    } else {
      cal(`E${r}`, price, { fmt: MONEY });
    }
    cal(`H${r}`, inv.email);
    cal(`I${r}`, inv.label);
    r += 1;
  }
  return wb;
}

// ---------- Soát file gửi ra ngoài ----------

const FORBIDDEN = [
  [/kwh/i, 'chữ kWh'],
  [/\bEVN\b/i, 'chữ EVN'],
  [/chiết\s*khấu/i, 'chữ chiết khấu'],
  [/mua\s*bán\s*điện|bán\s*điện|mua\s*điện/i, 'chữ mua bán điện'],
  [/tiết\s*kiệm/i, 'chữ tiền tiết kiệm'],
  [/\b(82|85|18|15)\s*%/, 'tỷ lệ phần trăm chiết khấu'],
];

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((x) => x.text).join('');
    if (v.formula !== undefined) return `${v.formula}`;
    if (v instanceof Date) return '';
    return String(v.text ?? v.result ?? '');
  }
  return String(v);
}

export function auditWorkbook(wb, label) {
  const issues = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => row.eachCell((cell) => {
      const t = cellText(cell.value);
      for (const [re, what] of FORBIDDEN) {
        if (re.test(t)) issues.push(`${label} · ${ws.name}!${cell.address}: có ${what}`);
      }
    }));
  });
  return issues;
}

// ---------- Ghép tất cả ----------

export function fileNames(project, period) {
  const mm = pad2(period.month);
  const yy = String(period.year).slice(-2);
  const lbl = project.billing.invoice?.label || project.name;
  return {
    client: `T${mm}.${yy} ${lbl} (Thanh Toán).xlsx`,
    internal: `T${mm}.${yy} Số liệu sử dụng điện ${lbl}.xlsx`,
    summary: `Số liệu xuất hóa đơn T${mm}${period.year}.xlsx`,
  };
}

const toBytes = async (wb) => new Uint8Array(await wb.xlsx.writeBuffer());

/**
 * @param history  lịch sử tất cả các tháng (đã chốt)
 * @returns { files: [{name, data, kind}], issues: string[], notes: string[] }
 */
export async function buildAll(cfg, period, history, settings) {
  const ExcelJS = await loadExcelJS();
  const key = `${period.year}-${pad2(period.month)}`;
  const month = history[key] || {};
  const files = [];
  const issues = [];
  const notes = [];
  const hoursByProject = {};

  for (const p of cfg.projects) {
    const rec = month[p.id];
    if (typeof rec?.hours === 'number') hoursByProject[p.id] = rec.hours;
    if (!p.billing || p.invoiceOnly || !rec || rec.manual) continue;
    const names = fileNames(p, period);
    const client = buildClientWorkbook(ExcelJS, cfg, p, period, rec.hours, settings);
    issues.push(...auditWorkbook(client.wb, names.client));
    if (client.missingAccount) notes.push('Chưa nhập số tài khoản nhận tiền ở Cài đặt: Giấy đề nghị đang để dấu chấm, anh điền tay trước khi gửi.');
    files.push({ name: names.client, data: await toBytes(client.wb), kind: 'client' });
    const internal = buildInternalWorkbook(ExcelJS, cfg, p, period, rec, history);
    if (internal.result.hours !== rec.hours) issues.push(`${p.name}: số giờ tính lại (${internal.result.hours}) khác số đã chốt (${rec.hours})`);
    files.push({ name: names.internal, data: await toBytes(internal.wb), kind: 'internal' });
  }

  const summaryProject = cfg.projects.find((p) => p.billing);
  if (summaryProject && Object.keys(hoursByProject).length) {
    const invoice = buildInvoiceWorkbook(ExcelJS, cfg, period, hoursByProject);
    const name = fileNames(summaryProject, period).summary;
    issues.push(...auditWorkbook(invoice, name));
    files.push({ name, data: await toBytes(invoice), kind: 'summary' });
    const blank = cfg.projects.filter((p) => p.billing?.invoice && typeof hoursByProject[p.id] !== 'number').map((p) => p.billing.invoice.label || p.name);
    if (blank.length) notes.push(`Dòng ${blank.join(', ')} trong file xuất hóa đơn để trống số giờ (chưa chốt kỳ này).`);
  }
  return { files, issues, notes };
}
