// Giao diện tùy chỉnh: xuất gói cho Gemini chỉnh CSS, rồi nạp CSS trả về đè lên giao diện gốc.
// Chỉ đổi CSS, không đụng HTML hay JS nên không thể làm sai số liệu.

export const MAX_CSS = 1_500_000; // ký tự; localStorage mỗi trang chừng 5 MB

// Lấy CSS từ thứ anh dán: khối ```css, thẻ <style>, hoặc chính nội dung nếu là CSS thuần.
export function extractCss(text) {
  let t = String(text ?? '');
  const fences = [...t.matchAll(/```[a-z]*[ \t]*\r?\n([\s\S]*?)```/gi)].map((m) => m[1]);
  if (fences.length) t = fences.sort((a, b) => b.length - a.length)[0];
  const styles = [...t.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  if (styles.length) t = styles.join('\n');
  return t.trim();
}

export function checkCss(css) {
  if (!css) return 'Chưa có nội dung CSS.';
  if (!/\{[\s\S]*\}/.test(css)) return 'Không thấy luật CSS nào (dạng .ten { ... }).';
  if (/<\/?(html|body|script|div)\b/i.test(css)) return 'Trong đó còn thẻ HTML hoặc script. Anh chỉ dán phần CSS.';
  if (css.length > MAX_CSS) return 'CSS quá lớn, thiết bị không lưu được. Nhờ Gemini bỏ bớt ảnh nhúng.';
  const open = (css.match(/\{/g) || []).length;
  const close = (css.match(/\}/g) || []).length;
  if (open !== close) return 'CSS bị cắt dở (số dấu { và } không bằng nhau). Nhờ Gemini gửi lại đầy đủ.';
  return '';
}

export function applyCss(css) {
  let el = document.getElementById('ecs-theme');
  if (!css) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('style');
    el.id = 'ecs-theme';
    document.head.appendChild(el); // sau css gốc nên đè được
  }
  el.textContent = css;
}

export function buildBrief({ css, sample, cssUrl }) {
  return `NHỜ GEMINI THIẾT KẾ LẠI GIAO DIỆN CHO APP "ECOSHINE CHỐT SỐ"

Em là nhà thiết kế web. Hãy làm đẹp giao diện của app bên dưới, CHỈ bằng CSS.

1. APP LÀ GÌ
Web app một trang (HTML + JavaScript thuần, không framework) dùng hằng tháng để chốt số công tơ: người dùng thả ảnh công tơ, app đọc chỉ số rồi tính ra số giờ thuê và tiền. Người dùng là giám đốc, mở trên iPhone (chính) và máy tính. Chữ tiếng Việt, nhiều con số nên số phải rõ, to, dễ đọc, thẳng hàng. Cần giao diện chuyên nghiệp, sạch, ngành năng lượng mặt trời (xanh lá đang là màu thương hiệu #0f6b4f, anh có thể đề xuất phối màu khác).

2. VIỆC CẦN LÀM
Trả về MỘT khối mã CSS duy nhất, đầy đủ (không viết tắt, không "giữ nguyên phần còn lại"). Khối này được nạp đè lên CSS gốc ở mục 6. Bản CSS của anh có thể viết lại toàn bộ cho đẹp, miễn tuân thủ mục 3.

3. LUẬT BẮT BUỘC
- Chỉ CSS. Không sửa HTML, không thêm JavaScript, không đổi tên class, id hay thuộc tính data-*.
- Không được ẩn (display:none, visibility:hidden, kích thước 0, màu trùng nền) bất cứ ô nhập, nút, bảng số, cảnh báo (.flag) hay khối .internal.
- Giữ chỗ mỗi thành phần như cũ về chức năng: thanh tab .tabs cố định ở đáy màn hình; tiêu đề .top cố định ở đầu; hộp thoại dialog.pin dùng thẻ <dialog>.
- Ô khóa input[readonly][data-lock] phải nhìn khác ô sửa được (mờ hơn, con trỏ pointer), vì người dùng chạm vào đó để nhập PIN.
- Ô "Đầu kỳ" (.start) là số chỉ đọc, phải nhìn ra là không sửa được. Số dùng chữ số đều bề rộng (font-variant-numeric: tabular-nums), căn phải.
- Bấm được thì cao tối thiểu 44px (iPhone). Không tràn ngang trên màn hình 360px. Chừa vùng an toàn env(safe-area-inset-*) như bản gốc.
- Có chế độ tối bằng @media (prefers-color-scheme: dark), đặt màu vào biến CSS trong :root như bản gốc.
- Chữ nền phải đủ tương phản (độ tương phản tối thiểu 4.5:1).
- Phông chữ: dùng chữ hệ thống có dấu tiếng Việt tốt, hoặc @import Google Fonts (Be Vietnam Pro, Inter, Roboto đều có tiếng Việt) kèm chữ dự phòng hệ thống.
- Muốn có ảnh, họa tiết, biểu tượng: tự vẽ bằng SVG rồi nhúng thẳng vào CSS dạng data:image/svg+xml (không liên kết ảnh ngoài, không file ảnh rời). Tổng CSS không quá 300 KB.
- Tên màn hình: Chốt tháng, Xuất file, Lịch sử, Cài đặt (thanh tab dưới đáy).

4. ĐỊNH DẠNG TRẢ LỜI
Chỉ trả đúng một khối \`\`\`css ... \`\`\` chứa toàn bộ CSS. Bên ngoài khối này viết tối đa 5 dòng mô tả phong cách. Người dùng sẽ copy cả câu trả lời dán vào app, app tự lấy phần trong khối css.

5. MÃ HTML MẪU (cấu trúc thật của app, số liệu giả)
Đây là màn hình Chốt tháng với một dự án mẫu, gồm: thẻ chọn kỳ, ô thả ảnh, thẻ ảnh đã đọc, bảng chỉ số, đơn giá, kết quả số giờ và hóa đơn, chi tiết nội bộ. Các màn hình khác dùng cùng bộ class trong CSS bên dưới (.card, .hrow, .chip, .frow, button, label, input...).

\`\`\`html
${sample}
\`\`\`

6. CSS GỐC HIỆN TẠI (css/style.css${cssUrl ? `, cũng đọc được tại ${cssUrl}` : ''})

\`\`\`css
${css}
\`\`\`
`;
}
