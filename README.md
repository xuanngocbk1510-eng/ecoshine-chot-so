# Ecoshine Chốt Số

Web app (cài được lên điện thoại như app) để chốt số điện hằng tháng: chọn nhiều ảnh công tơ cùng lúc, AI đọc chỉ số, app tính kWh, tiền, số giờ thuê và tiền hóa đơn đúng quy trình Ecoshine.

Không cần build. Toàn bộ là HTML + JavaScript tĩnh nên chạy được trên GitHub Pages.

## Nguyên tắc dữ liệu
- Kho mã này **công khai** (GitHub Pages). Không đưa vào đây: đơn giá, chiết khấu, số seri công tơ, chỉ số, lịch sử các tháng, khóa API. Thư mục `private/` đã nằm trong `.gitignore`.
- Cấu hình dự án và lịch sử nằm trong trình duyệt của từng thiết bị (nạp bằng file `.json` riêng tư, sao lưu ở trang Lịch sử).
- Khóa API chỉ lưu trong trình duyệt. Hãy đặt hạn mức chi tiêu thấp cho khóa.

## Chạy thử trên máy
```bash
python -m http.server 8765 --directory .
```
Mở http://localhost:8765. Bộ test: http://localhost:8765/tests/engine.test.html (phải hiện "Tất cả đạt").

## Đưa lên GitHub Pages
1. Tạo kho **công khai** mới, đẩy toàn bộ thư mục này lên (không có `private/`).
2. Settings → Pages → Deploy from branch → `main` / root.
3. Mở link `https://<tên>.github.io/<kho>/` trên điện thoại, chọn "Thêm vào màn hình chính".
4. Ở Cài đặt: dán khóa API, nạp file cấu hình `.json` (mẫu: `private/cau-hinh.json`).

## Cấu trúc
- `js/engine.js` bộ tính (thuần hàm, có test).
- `js/ocr.js` thu nhỏ ảnh và gọi AI đọc chỉ số.
- `js/store.js` lưu cấu hình, lịch sử trong trình duyệt.
- `js/app.js` giao diện.

## Xuất file (tab "Xuất file")
Dựng bằng ExcelJS (đã kèm sẵn trong `js/vendor`, dùng được khi mất mạng) theo đúng bố cục các file tháng trước:
- `T<tháng>.<năm> <dự án> (Thanh Toán).xlsx`: biên bản số giờ + giấy đề nghị thanh toán. Gửi khách.
- `Số liệu xuất hóa đơn T<tháng><năm>.xlsx`: gộp các khách, chỉ số giờ. Gửi kế toán.
- `T<tháng>.<năm> Số liệu sử dụng điện <dự án>.xlsx`: có kWh, giữ nội bộ.

Trước khi cho tải, app soát hai file gửi ngoài, nếu còn chữ kWh, EVN, chiết khấu, mua bán điện, tiền tiết kiệm hay tỷ lệ phần trăm chiết khấu thì chặn. Gói `.zip` tách thư mục "Nội bộ" riêng. Nút Chia sẻ chỉ gửi file gửi ngoài.
Số tài khoản nhận tiền do anh gõ ở Cài đặt, lưu trong trình duyệt, không nằm trong cấu hình hay bản sao lưu.
Dự án đặt `"invoiceOnly": true` chưa có công tơ trong app: anh gõ số giờ tay ở tab Xuất file để vào file kế toán.
Bộ test: `tests/export.test.html`.

## Còn làm tiếp
- Thêm Toàn Cầu 1 (hai công tơ, mái tôn, phản kháng) và Toàn Cầu 2.
- Giai đoạn 4: đồng bộ lịch sử giữa điện thoại và máy tính qua kho riêng tư.
