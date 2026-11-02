// Đọc ảnh công tơ / ảnh chụp màn hình bằng Gemini. Gọi thẳng từ trình duyệt, khóa API do anh tự nhập.

export const DEFAULT_MODEL = 'gemini-3.8-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_EDGE = 1600;

// Lược đồ kết quả (kiểu OpenAPI của Gemini: nullable thay cho mảng kiểu có "null").
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    image_kind: { type: 'STRING', enum: ['meter_photo', 'screenshot', 'other'], description: 'meter_photo: ảnh chụp mặt công tơ; screenshot: ảnh chụp màn hình có bảng chỉ số; other: không liên quan' },
    photo_time: { type: 'STRING', nullable: true, description: 'Ngày giờ in trên ảnh (watermark), đúng như thấy; null nếu không có' },
    place: { type: 'STRING', nullable: true, description: 'Địa điểm in trên ảnh; null nếu không có' },
    meters: {
      type: 'ARRAY',
      description: 'Mỗi công tơ nhìn thấy trong ảnh một phần tử',
      items: {
        type: 'OBJECT',
        properties: {
          serial: { type: 'STRING', nullable: true, description: 'Số sx / số seri in trên công tơ; null nếu không thấy rõ' },
          readings: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                register: { type: 'STRING', description: 'Mã thanh ghi trên màn hình, ví dụ 2.8.0, 2.8.1, 2.8.2, 2.8.3, 1.8.1' },
                value: { type: 'NUMBER', nullable: true, description: 'Số kWh đọc được, giữ phần thập phân (dấu chấm); null nếu không đọc được' },
                confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
              },
              required: ['register', 'value', 'confidence'],
            },
          },
        },
        required: ['serial', 'readings'],
      },
    },
    note: { type: 'STRING', nullable: true, description: 'Điều cần người xem lưu ý (ảnh mờ, chói, số bị che...); null nếu không có' },
  },
  required: ['image_kind', 'meters'],
};

const PROMPT = [
  'Đây là ảnh chỉ số điện của công tơ điện tử (mặt công tơ có màn hình LCD) hoặc ảnh chụp màn hình có bảng chỉ số.',
  'Hãy đọc: mã thanh ghi ở góc trên màn hình LCD (dạng 2.8.0, 2.8.1, 2.8.2, 2.8.3), số kWh ở dòng lớn bên dưới, và số sx (số seri) in trên nhãn công tơ.',
  'Quy tắc: chỉ ghi chữ số nhìn thấy thật, không suy đoán, không làm tròn. Nếu một chữ số bị chói hoặc che thì để value là null và nói rõ ở note.',
  'Dấu thập phân là dấu chấm. Đừng nhầm số seri hoặc mã vạch với chỉ số kWh.',
  'Ảnh chụp màn hình có nhiều dòng thì ghi mỗi dòng một reading.',
  'Trả về đúng một đối tượng JSON theo lược đồ đã cho, không thêm chữ nào khác.',
].join('\n');

// Thu nhỏ ảnh về tối đa MAX_EDGE px để gửi nhanh, rẻ; trả thêm ảnh nhỏ để hiện ở bảng xác nhận.
export async function prepareImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const draw = (s) => {
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  };
  const big = draw(scale);
  const small = draw(Math.min(1, 240 / Math.max(bmp.width, bmp.height)));
  bmp.close?.();
  return {
    base64: big.toDataURL('image/jpeg', 0.85).split(',')[1],
    thumb: small.toDataURL('image/jpeg', 0.7),
  };
}

export function buildRequest(base64) {
  return {
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/jpeg', data: base64 } },
        { text: PROMPT },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: SCHEMA,
      maxOutputTokens: 4096,
    },
  };
}

// Lấy đối tượng kết quả từ phản hồi của Gemini; ném lỗi tiếng Việt nếu bị chặn hoặc không đọc được.
export function parseResponse(data) {
  if (data.promptFeedback?.blockReason) throw new Error(`Gemini từ chối ảnh (${data.promptFeedback.blockReason})`);
  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error(`Gemini không trả kết quả${cand?.finishReason ? ` (${cand.finishReason})` : ''}`);
  const json = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let out;
  try {
    out = JSON.parse(json);
  } catch {
    throw new Error(`Kết quả không đọc được${cand.finishReason === 'MAX_TOKENS' ? ' (bị cắt giữa chừng)' : ''}`);
  }
  if (!Array.isArray(out.meters)) out.meters = [];
  return out;
}

export async function readImage({ apiKey, model = DEFAULT_MODEL, base64 }) {
  const res = await fetch(`${API_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(buildRequest(base64)),
  });
  if (!res.ok) {
    const body = await res.text();
    let msg = body.slice(0, 200);
    try { msg = JSON.parse(body).error?.message || msg; } catch { /* giữ nguyên chuỗi */ }
    const hint = res.status === 400 && /API key/i.test(msg) ? 'Khóa API sai hoặc chưa bật.'
      : res.status === 403 ? 'Khóa không có quyền dùng mô hình này.'
      : res.status === 404 ? `Không tìm thấy mô hình "${model}", kiểm tra tên ở Cài đặt.`
      : res.status === 429 ? 'Quá giới hạn tốc độ hoặc hết hạn mức, thử lại sau ít phút.' : '';
    throw new Error(`Lỗi ${res.status}. ${hint} ${msg}`.replace(/\s+/g, ' ').trim());
  }
  return parseResponse(await res.json());
}

// Đọc nhiều ảnh, tối đa `limit` ảnh chạy song song. onProgress(index, state, result|error).
export async function readMany(files, { apiKey, model, limit = 3, onProgress = () => {} }) {
  const results = new Array(files.length);
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      try {
        onProgress(i, 'prepare');
        const img = await prepareImage(files[i]);
        onProgress(i, 'reading', { thumb: img.thumb });
        const parsed = await readImage({ apiKey, model, base64: img.base64 });
        results[i] = { ok: true, thumb: img.thumb, name: files[i].name, parsed };
        onProgress(i, 'done', results[i]);
      } catch (err) {
        results[i] = { ok: false, name: files[i].name, error: err.message };
        onProgress(i, 'error', results[i]);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
  return results;
}

// Mã thanh ghi -> khung giờ. Chấp nhận x.8.0 (tổng), x.8.1, x.8.2, x.8.3 với x là 1 hoặc 2: mã chỉ là nhãn.
export function registerToSlot(register) {
  const m = String(register || '').replace(/\s/g, '').match(/^[12]\.8\.([0-3])$/);
  if (!m) return null;
  return ['total', 'normal', 'peak', 'low'][Number(m[1])];
}
