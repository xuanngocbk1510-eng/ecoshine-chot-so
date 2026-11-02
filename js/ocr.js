// Đọc ảnh công tơ / ảnh chụp màn hình bằng Claude. Gọi thẳng từ trình duyệt, khóa API do anh tự nhập.

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const MAX_EDGE = 1600;

const TOOL = {
  name: 'ghi_chi_so',
  description: 'Ghi lại chỉ số điện đọc được từ một ảnh.',
  input_schema: {
    type: 'object',
    properties: {
      image_kind: {
        type: 'string',
        enum: ['meter_photo', 'screenshot', 'other'],
        description: 'meter_photo: ảnh chụp mặt công tơ; screenshot: ảnh chụp màn hình có bảng chỉ số; other: không liên quan',
      },
      photo_time: { type: ['string', 'null'], description: 'Ngày giờ in trên ảnh (watermark), định dạng như thấy, null nếu không có' },
      place: { type: ['string', 'null'], description: 'Địa điểm in trên ảnh, null nếu không có' },
      meters: {
        type: 'array',
        description: 'Mỗi công tơ nhìn thấy trong ảnh một phần tử',
        items: {
          type: 'object',
          properties: {
            serial: { type: ['string', 'null'], description: 'Số sx / số seri in trên công tơ, null nếu không thấy rõ' },
            readings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  register: { type: 'string', description: 'Mã thanh ghi hiển thị trên màn hình, ví dụ 2.8.0, 2.8.1, 2.8.2, 2.8.3, 1.8.1' },
                  value: { type: ['number', 'null'], description: 'Số kWh đọc được, giữ phần thập phân nếu có (dấu chấm). null nếu không đọc được' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                },
                required: ['register', 'value', 'confidence'],
              },
            },
          },
          required: ['serial', 'readings'],
        },
      },
      note: { type: ['string', 'null'], description: 'Điều cần người xem lưu ý (ảnh mờ, bị chói, số bị che...)' },
    },
    required: ['image_kind', 'meters'],
  },
};

const PROMPT = [
  'Đây là ảnh chỉ số điện của công tơ điện tử (mặt công tơ có màn hình LCD) hoặc ảnh chụp màn hình có bảng chỉ số.',
  'Hãy đọc: mã thanh ghi ở góc trên màn hình LCD (dạng 2.8.0, 2.8.1, 2.8.2, 2.8.3), số kWh ở dòng lớn bên dưới, và số sx (số seri) in trên nhãn công tơ.',
  'Quy tắc: chỉ ghi chữ số nhìn thấy thật, không suy đoán, không làm tròn. Nếu một chữ số bị chói hoặc che thì để value là null và nói rõ ở note.',
  'Dấu thập phân là dấu chấm. Đừng nhầm số seri hoặc mã vạch với chỉ số kWh.',
  'Ảnh chụp màn hình có nhiều dòng thì ghi mỗi dòng một reading. Luôn gọi công cụ ghi_chi_so.',
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

export async function readImage({ apiKey, model = DEFAULT_MODEL, base64 }) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: TOOL.name },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: PROMPT },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const hint = res.status === 401 ? 'Khóa API sai hoặc hết hạn.' : res.status === 429 ? 'Quá giới hạn tốc độ, thử lại sau ít phút.' : '';
    throw new Error(`Lỗi ${res.status}. ${hint} ${body.slice(0, 200)}`.trim());
  }
  const data = await res.json();
  const block = data.content?.find((b) => b.type === 'tool_use');
  if (!block) throw new Error('AI không trả về kết quả đọc được');
  return block.input;
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
