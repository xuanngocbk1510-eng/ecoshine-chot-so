// Lưu cài đặt, cấu hình dự án và lịch sử các tháng đã chốt trong trình duyệt (localStorage).
// Giai đoạn sau sẽ đồng bộ sang kho riêng tư trên GitHub; mọi truy cập đi qua file này để dễ thay.

const KEYS = { settings: 'ecs.settings', config: 'ecs.config', history: 'ecs.history' };

const EMPTY_CONFIG = {
  company: { hourPrice: 500000, vat: 0.08 },
  projects: [],
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const settings = {
  get: () => read(KEYS.settings, { apiKey: '', model: '' }),
  set: (v) => write(KEYS.settings, v),
};

export const config = {
  get: () => read(KEYS.config, structuredClone(EMPTY_CONFIG)),
  set: (v) => write(KEYS.config, v),
};

export const history = {
  get: () => read(KEYS.history, {}),
  set: (v) => write(KEYS.history, v),
};

export const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

// Chỉ số đầu kỳ của một công tơ = cuối kỳ của tháng đã chốt gần nhất trước `key`; chưa có thì lấy chỉ số khởi tạo trong cấu hình.
export function startFor(project, meter, key) {
  const hist = history.get();
  const months = Object.keys(hist).filter((k) => k < key).sort().reverse();
  for (const k of months) {
    const end = hist[k]?.[project.id]?.readings?.[meter.id]?.end;
    if (end) return { value: { ...end }, from: k };
  }
  return { value: { ...(meter.seed || {}) }, from: null };
}

export function exportAll() {
  return JSON.stringify({ config: config.get(), history: history.get(), exportedAt: new Date().toISOString() }, null, 2);
}

export function importAll(text) {
  const data = JSON.parse(text);
  if (data.config) config.set(data.config);
  if (data.history) history.set(data.history);
  if (!data.config && !data.history && data.projects) config.set(data);
  return { config: !!data.config || !!data.projects, history: !!data.history };
}
