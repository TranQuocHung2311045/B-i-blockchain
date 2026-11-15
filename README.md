# Moto Maintenance Chain

Hệ thống web quản lý lịch sử bảo dưỡng / sửa chữa xe máy kết hợp Blockchain nhằm chống gian lận ODO và minh bạch thông tin xe cũ.

## Kiến trúc

```
Trình duyệt (HTML/JS + ethers.js + MetaMask)
      │  REST API                      │  ký giao dịch
      ▼                                ▼
Backend Node.js/Express ── SQLite   Smart Contract (Sepolia)
(dữ liệu chi tiết)                  (chỉ lưu mã băm SHA-256)
```

- **Off-chain (SQLite):** biển số, ngày, ODO, loại việc, mô tả, chi phí, garage.
- **On-chain (Sepolia):** mã băm SHA-256 của từng mốc bảo trì, kèm địa chỉ garage và thời gian.
- **Chuỗi băm:** `hash = SHA256([biển số, ngày, ODO, loại, mô tả, chi phí, garage, hash_mốc_trước])`. Sửa một mốc cũ thì mã băm đổi, kéo theo toàn bộ các mốc sau bị đứt chuỗi.
- **Chống gian lận ODO:** backend từ chối mốc có ODO nhỏ hơn mốc trước; khi tra cứu vẫn kiểm tra lại toàn bộ lịch sử.

## Cấu trúc thư mục

```
contracts/   Smart contract (Solidity) + Hardhat + script deploy
backend/     Express API, SQLite, giao diện web (public/index.html)
```

## Cài đặt và chạy

Yêu cầu: Node.js 18+ và tiện ích MetaMask (đã có ít ETH test trên Sepolia, lấy từ faucet).

### 1. Deploy Smart Contract

```bash
cd contracts
npm install
cp .env.example .env      # điền SEPOLIA_RPC_URL (Alchemy/Infura) và PRIVATE_KEY (ví TEST)
npm run deploy
```
Ghi lại dòng `Contract address: 0x...`. (Cách khác: dán file `.sol` vào remix.ethereum.org rồi deploy bằng MetaMask.)

### 2. Chạy backend + giao diện

```bash
cd backend
npm install
cp .env.example .env      # điền CONTRACT_ADDRESS
npm start
```
Mở http://localhost:3000

### 3. Sử dụng

1. Bấm **Kết nối MetaMask** (mạng Sepolia). Ví deploy contract là garage được cấp phép; garage khác cần chủ contract gọi `setGarage(địa chỉ, true)`.
2. Tab **Ghi bảo trì**: nhập mốc mới, hệ thống lưu CSDL và tạo mã băm.
3. Tab **Tra cứu**: nhập biển số, bấm **Neo lên Sepolia** để ghi mã băm lên blockchain.
4. Người mua tra cứu biển số hoặc quét mã QR, bấm **Xác thực on-chain** để đối chiếu mã băm.

### Kiểm thử phát hiện gian lận

Mở `backend/moto.db` bằng DB Browser for SQLite, sửa `odo` hoặc `description` của một dòng, rồi tra cứu lại: mốc đó báo "Dữ liệu bị sửa" và các mốc sau báo "Chuỗi đứt".

## API

| Method | Đường dẫn | Mô tả |
|---|---|---|
| POST | `/api/records` | Thêm mốc bảo trì, trả về mã băm |
| GET | `/api/vehicles/:plate` | Lịch sử + kết quả kiểm tra toàn vẹn |
| PATCH | `/api/records/:id/tx` | Lưu mã giao dịch sau khi neo |
| GET | `/api/config` | Địa chỉ contract, chainId |

## Hạn chế và hướng phát triển

- Chưa có đăng nhập cho garage (hiện chỉ giới hạn quyền neo bằng ví on-chain).
- Quét QR bằng camera chưa có; mã QR dẫn tới trang tra cứu.
- Có thể chuyển SQLite sang MySQL/PostgreSQL bằng cách thay lớp truy cập dữ liệu trong `server.js`.
- Không bao giờ dùng ví chứa tiền thật cho `PRIVATE_KEY`.
