// Khóa quyền sửa đơn giá và cấu hình bằng mã PIN của anh. Chỉ lưu dấu băm (PBKDF2), không lưu mã gốc.
// Đây là khóa mềm trên từng thiết bị: ngăn người khác cầm máy bấm nhầm hoặc sửa số, không phải két sắt.

const KEY = 'ecs.lock';
const OPEN_MS = 10 * 60 * 1000;   // mở khóa xong tự khóa lại sau 10 phút
const MAX_TRIES = 5;
const WAIT_MS = 60 * 1000;

let openUntil = 0;
let fails = 0;
let blockedUntil = 0;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}

async function derive(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256));
}

export const hasPin = () => !!read();

// Được sửa khi chưa đặt PIN (lần đầu nạp cấu hình) hoặc đang trong thời gian mở khóa.
export const canEdit = () => !hasPin() || Date.now() < openUntil;

export function lockNow() { openUntil = 0; }

export function validPin(pin) {
  return typeof pin === 'string' && pin.length >= 4 && pin.length <= 12;
}

export async function setPin(pin) {
  if (!validPin(pin)) throw new Error('Mã PIN từ 4 đến 12 ký tự');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  localStorage.setItem(KEY, JSON.stringify({ salt: b64(salt), hash: await derive(pin, salt) }));
  openUntil = Date.now() + OPEN_MS;
}

// Trả về true nếu đúng PIN (và mở khóa), false nếu sai. Sai 5 lần thì chờ 1 phút.
export async function unlock(pin) {
  const rec = read();
  if (!rec) return true;
  const now = Date.now();
  if (now < blockedUntil) throw new Error(`Nhập sai nhiều lần, thử lại sau ${Math.ceil((blockedUntil - now) / 1000)} giây`);
  const ok = (await derive(String(pin ?? ''), unb64(rec.salt))) === rec.hash;
  if (ok) {
    fails = 0;
    openUntil = Date.now() + OPEN_MS;
    return true;
  }
  fails += 1;
  if (fails >= MAX_TRIES) { fails = 0; blockedUntil = Date.now() + WAIT_MS; }
  return false;
}

// Xóa PIN (chỉ gọi khi đang mở khóa).
export function clearPin() {
  if (!canEdit()) throw new Error('Cần mở khóa trước');
  localStorage.removeItem(KEY);
}
