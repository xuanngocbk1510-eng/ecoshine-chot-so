// Bộ tính chốt tiền hằng tháng. Thuần hàm, không đụng giao diện hay lưu trữ.
// Quy trình: kWh -> tiền điện nội bộ -> chiết khấu -> trừ khoản phát sinh -> VAT -> số giờ -> hóa đơn.

export const SLOTS = ['normal', 'peak', 'low'];
export const SLOT_LABEL = {
  normal: 'Giờ bình thường',
  peak: 'Giờ cao điểm',
  low: 'Giờ thấp điểm',
};

// Làm tròn hệ thập phân thường (0,5 trở lên thì lên), có bù sai số dấu phẩy động.
export function roundHalfUp(x, digits = 0) {
  const f = 10 ** digits;
  return Math.round(x * f + 1e-9) / f;
}

const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? 0 : Number(v));

// Chỉ số một công tơ -> kWh dùng theo từng khung giờ.
export function meterUsage(reading, integerReadings = true) {
  const fix = (v) => (integerReadings ? roundHalfUp(num(v), 0) : num(v));
  const out = {};
  for (const s of SLOTS) {
    const start = fix(reading.start?.[s]);
    const end = fix(reading.end?.[s]);
    out[s] = end - start;
  }
  return out;
}

/**
 * @param project  { discount, integerReadings?, roof?: {share}, meters: [{id}] }
 * @param rates    { hourPrice, vat }
 * @param input    { readings: {[meterId]: {start:{normal,peak,low}, end:{...}}},
 *                   prices: {normal,peak,low},
 *                   roofBalance?: number, reactive?: number, adjust?: number }
 */
export function computeProject(project, rates, input) {
  const warnings = [];
  const integer = project.integerReadings !== false;

  const kwh = { normal: 0, peak: 0, low: 0 };
  const perMeter = {};
  for (const m of project.meters) {
    const r = input.readings?.[m.id];
    if (!r) {
      warnings.push(`Thiếu chỉ số công tơ ${m.label || m.id}`);
      continue;
    }
    const u = meterUsage(r, integer);
    perMeter[m.id] = u;
    for (const s of SLOTS) {
      if (u[s] < 0) warnings.push(`${m.label || m.id}: chỉ số cuối kỳ nhỏ hơn đầu kỳ (${SLOT_LABEL[s].toLowerCase()})`);
      kwh[s] += u[s];
    }
  }

  const money = {};
  let total = 0;
  for (const s of SLOTS) {
    money[s] = kwh[s] * num(input.prices?.[s]);
    total += money[s];
  }

  const use = total * num(project.discount);
  const saving = total - use;

  let roof = 0;
  if (project.roof) {
    const share = num(project.roof.share ?? 0.5);
    roof = Math.max(0, Math.min(num(input.roofBalance), share * saving));
  }
  const reactive = Math.max(0, num(input.reactive));
  // Bù trừ các kỳ trước: số có dấu, dương là thu thêm (tính thiếu), âm là giảm (tính thừa).
  const adjust = num(input.adjust);

  // Mái tôn là khoản Ecoshine thu lại từ phần tiết kiệm của khách, nên cộng vào tiền khách trả;
  // phản kháng là khoản Ecoshine chịu, nên trừ.
  const base = use + roof + adjust - reactive;
  const vatRate = num(rates.vat);
  const withVat = base * (1 + vatRate);
  const hoursRaw = withVat / (1 + vatRate) / num(rates.hourPrice);
  const hours = roundHalfUp(hoursRaw, 1);

  const before = hours * num(rates.hourPrice);
  const invoice = {
    before: roundHalfUp(before, 0),
    after: roundHalfUp(before * (1 + vatRate), 0),
  };
  invoice.vat = invoice.after - invoice.before;

  if (!(hours > 0)) warnings.push('Số giờ bằng 0 hoặc âm, kiểm tra lại chỉ số và đơn giá');

  return {
    kwh, perMeter, money, total, use, saving,
    adjustments: { roof, reactive, adjust },
    base, withVat, hoursRaw, hours, invoice, warnings,
  };
}

// Kiểm tra chéo: 2.8.1 + 2.8.2 + 2.8.3 phải bằng 2.8.0 (sai số cho phép do làm tròn hiển thị).
// maxOnly: dự án bỏ thấp điểm có khung thấp điểm lấy bằng đầu kỳ nên tổng công tơ được phép lớn hơn; chỉ báo khi ba khung vượt tổng.
export function checkTotal(slots, total, tolerance = 1.01, maxOnly = false) {
  const sum = SLOTS.reduce((a, s) => a + num(slots[s]), 0);
  const diff = sum - num(total);
  return { sum, diff, ok: maxOnly ? diff <= tolerance : Math.abs(diff) <= tolerance };
}

// Ngày cuối tháng (month 1..12).
export function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export const fmt = {
  vnd: (v) => Math.round(v).toLocaleString('vi-VN'),
  n1: (v) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
  n2: (v) => Number(v).toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  int: (v) => Math.round(v).toLocaleString('vi-VN'),
};
